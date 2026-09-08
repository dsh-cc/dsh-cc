/**
 * Integration tests against real `git` on a throwaway repository, driving the
 * tool through a real local bash executor and real filesystem. These cover the
 * create / keep / remove / discard paths end-to-end (real worktrees on disk).
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
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
  ({ inject: () => undefined, session: { header: { version: 0, id: 's', createdAt: 0, cwd: repo } } }) as unknown as Agent

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
