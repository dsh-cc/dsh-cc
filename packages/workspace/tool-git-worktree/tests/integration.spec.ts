/**
 * Integration tests against real `git` on a throwaway repository, driving the
 * tool through a real local bash executor and real filesystem. These cover the
 * create / keep / remove / discard paths end-to-end (real worktrees on disk).
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolGitWorktree from '@dsh-cc/tool-git-worktree'
import { clearActiveWorktreeSession } from '../src/worktree.ts'

// Hook-environment hermeticity. Under a git hook (or any process inheriting
// one), git exports repo-pinning vars — GIT_INDEX_FILE relative to the
// worktree root — which re-resolve against each spawned git's own cwd and
// break the real-git fixtures below (proven: `git worktree add` respawns
// reset inside the linked worktree, where .git is a pointer file, and the
// inherited relative index path resolves to "Not a directory"). Strip the
// repo-pinning family so this suite is identical inside and outside hooks.
for (const v of [
  'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
]) delete process.env[v]

const signal = new AbortController().signal

beforeEach(() => clearActiveWorktreeSession())

/** Initialize a throwaway git repo with one committed file. */
function fixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-wt-ints-'))
  execSync('git init -q', { cwd: repo })
  execSync('git config user.email test@example.com && git config user.name Tester', { cwd: repo })
  writeFileSync(join(repo, 'file.txt'), 'hello\n')
  execSync('git add file.txt && git commit -qm initial', { cwd: repo })
  return repo
}

async function harness(repo: string) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { cwd: repo })
  await ctx.plugin(LocalFileSystem, { cwd: repo })
  await ctx.plugin(ToolGitWorktree)
  return ctx
}

const agentAt = (repo: string): Agent =>
  ({ inject: () => undefined, session: { header: { version: 3, id: 's', createdAt: 0, cwd: repo } } }) as unknown as Agent

function call(ctx: Context, name: string, args: unknown, agent: Agent) {
  return ctx.tools.execute({ signal, callId: ToolCallId(`${name}-${Math.random().toString(36).slice(2)}`), name, arguments: args, agent })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('real-git worktree lifecycle', () => {
  it('creates a worktree on disk, keeps it, returns to the original cwd', async () => {
    const repo = fixtureRepo()
    const ctx = await harness(repo)
    const agent = agentAt(repo)

    const created = await call(ctx, 'EnterWorktree', { name: 'feat' }, agent)
    expect(created.isError).toBe(false)
    const worktreePath = (created.value as { worktreePath: string }).worktreePath
    expect(existsSync(worktreePath)).toBe(true)
    expect(existsSync(join(worktreePath, 'file.txt'))).toBe(true)

    const kept = await call(ctx, 'ExitWorktree', { action: 'keep' }, agent)
    expect(kept.isError).toBe(false)
    expect(text(kept)).toContain('preserved')
    expect(existsSync(worktreePath)).toBe(true)
  })

  it('refuses to remove a worktree with uncommitted changes, then removes it on discard', async () => {
    const repo = fixtureRepo()
    const ctx = await harness(repo)
    const agent = agentAt(repo)

    const created = await call(ctx, 'EnterWorktree', { name: 'feat' }, agent)
    expect(created.isError).toBe(false)
    const worktreePath = (created.value as { worktreePath: string }).worktreePath

    // Dirty the worktree.
    writeFileSync(join(worktreePath, 'dirty.txt'), 'wip\n')

    const refused = await call(ctx, 'ExitWorktree', { action: 'remove' }, agent)
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/1 uncommitted file/)
    expect(existsSync(worktreePath)).toBe(true)

    const removed = await call(ctx, 'ExitWorktree', { action: 'remove', discard_changes: true }, agent)
    expect(removed.isError).toBe(false)
    expect(text(removed)).toContain('Exited and removed')
    expect(existsSync(worktreePath)).toBe(false)

    // The branch was deleted too.
    const branch = execSync('git branch --list worktree-feat', { cwd: repo }).toString().trim()
    expect(branch).toBe('')
  })

  it('removes a clean worktree without requiring discard_changes', async () => {
    const repo = fixtureRepo()
    const ctx = await harness(repo)
    const agent = agentAt(repo)

    await call(ctx, 'EnterWorktree', { name: 'clean' }, agent)
    const removed = await call(ctx, 'ExitWorktree', { action: 'remove' }, agent)
    expect(removed.isError).toBe(false)
    expect(text(removed)).toContain('Exited and removed')
    expect(existsSync(join(repo, '.claude', 'worktrees', 'clean'))).toBe(false)
  })

  it('rejects a slug that escapes the worktrees directory', async () => {
    const repo = fixtureRepo()
    const ctx = await harness(repo)
    const agent = agentAt(repo)
    const result = await call(ctx, 'EnterWorktree', { name: '../escape' }, agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/invalid worktree name "\.\.\/escape"/)
    expect(text(result)).toMatch(/must not contain/)
  })
})

describe('WS-1 creation hardening (real git)', () => {
  it('anchors creation at the MAIN repo root when invoked from inside a linked worktree', async () => {
    const repo = fixtureRepo()
    const ctx = await harness(repo)
    const agent = agentAt(repo)
    const first = await call(ctx, 'EnterWorktree', { name: 'outer' }, agent)
    expect(first.isError).toBe(false)
    const outerPath = (first.value as { worktreePath: string }).worktreePath

    // Re-enter from INSIDE the first worktree: the new tree must be a
    // sibling under the main root's .claude/worktrees/, never nested.
    const agentInside = agentAt(outerPath)
    const second = await call(ctx, 'EnterWorktree', { name: 'inner' }, agentInside)
    expect(second.isError).toBe(false)
    const innerPath = (second.value as { worktreePath: string }).worktreePath
    expect(realpathSync(innerPath)).toBe(realpathSync(join(repo, '.claude', 'worktrees', 'inner')))
  })

  it('refuses creation when a route path is a symlink', async () => {
    const repo = fixtureRepo()
    const ctx = await harness(repo)
    const agent = agentAt(repo)
    symlinkSync('/nonexistent-dsh-wt-target', join(repo, '.claude'))
    const result = await call(ctx, 'EnterWorktree', { name: 'feat' }, agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('is a symlink')
    expect(text(result)).toContain(join(repo, '.claude'))
  })

  it('refuses to adopt an existing directory that is not a registered worktree', async () => {
    const repo = fixtureRepo()
    const ctx = await harness(repo)
    const agent = agentAt(repo)
    const target = join(repo, '.claude', 'worktrees', 'userdir')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'user-file.txt'), 'mine\n')
    const result = await call(ctx, 'EnterWorktree', { name: 'userdir' }, agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no .git entry')
    expect(text(result)).toContain('Remove or rename')
    // The directory is left in place.
    expect(existsSync(join(target, 'user-file.txt'))).toBe(true)
  })

  it('lets git decide on a properly registered existing worktree directory (identity gate passes)', async () => {
    const repo = fixtureRepo()
    const ctx = await harness(repo)
    const agent = agentAt(repo)
    const created = await call(ctx, 'EnterWorktree', { name: 'reent' }, agent)
    expect(created.isError).toBe(false)
    const worktreePath = (created.value as { worktreePath: string }).worktreePath
    await call(ctx, 'ExitWorktree', { action: 'keep' }, agent)

    // Re-entering the same name passes the WS-1 identity gate; `git worktree
    // add` itself refuses a registered path (still an error, but NOT an
    // identity refusal, and the directory is left untouched).
    const again = await call(ctx, 'EnterWorktree', { name: 'reent' }, agent)
    expect(again.isError).toBe(true)
    expect(text(again)).not.toContain('refusing to adopt')
    expect(existsSync(join(worktreePath, 'file.txt'))).toBe(true)
  })

  it('neutralizes repository-local filter drivers: no filter execution during worktree add', async () => {
    const repo = fixtureRepo()
    // Wire a "malicious-looking" filter driver: smudge rewrites content AND
    // appends to a marker file (the marker write is what a filter binary
    // would do; unsandboxed CI sees it appear iff the filter executed).
    const script = join(repo, 'smudge.sh')
    const marker = join(repo, 'smudge-marker')
    writeFileSync(script, `#!/bin/sh\ncat\nprintf '%s\\n' "$1" >> ${marker}\n`)
    execSync(`chmod +x ${script}`)
    execSync(`git config filter.dirty.smudge "${script} %f"`, { cwd: repo })
    execSync('git config filter.dirty.required true', { cwd: repo })
    // clean must succeed while committing .gitattributes (no write, unlike
    // the smudge script whose marker write is the execution evidence).
    execSync('git config filter.dirty.clean cat', { cwd: repo })
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=dirty\n')
    execSync('git add .gitattributes && git commit -qm attrs', { cwd: repo })

    const ctx = await harness(repo)
    const created = await call(ctx, 'EnterWorktree', { name: 'nofilter' }, agentAt(repo))
    expect(created.isError).toBe(false)
    const worktreePath = (created.value as { worktreePath: string }).worktreePath
    // The blob content must be untouched (smudge would produce a different
    // first line) and the marker file must not exist.
    expect(readFileSync(join(worktreePath, 'file.txt'), 'utf8')).toBe('hello\n')
    expect(existsSync(marker)).toBe(false)
  })

  it('refuses creation when the local config is unreadable or uses includeIf', async () => {
    const repo = fixtureRepo()
    execSync('git config includeif.gitdir:~/x/.path ~/x/.gitconfig', { cwd: repo })
    const ctx = await harness(repo)
    const result = await call(ctx, 'EnterWorktree', { name: 'feat' }, agentAt(repo))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('includeIf')
  })
})
