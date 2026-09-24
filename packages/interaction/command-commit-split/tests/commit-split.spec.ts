import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import * as commandCommitSplit from '@dsh-cc/command-commit-split'
import { DEPS_GROUP_MESSAGE, SCHEMA_ERROR } from '@dsh-cc/command-commit-split/plan'
import type { GitRun } from '@dsh-cc/command-commit-split'

/** Run a git command inside the fixture directory. */
function git(dir: string, args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
}

/**
 * Create a throwaway git repo with interleaved commits and a live dirty tree
 * (real git via child_process is allowed in tests, never in src).
 */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'commit-split-'))
  git(dir, ['init'])
  git(dir, ['config', 'user.email', 'spec@example.com'])
  git(dir, ['config', 'user.name', 'spec'])
  writeFileSync(join(dir, 'src-topic.ts'), 'export const topic = 1\n')
  writeFileSync(join(dir, 'src-topic.test.ts'), 'import { topic } from "./src-topic"\n')
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  // Interleaved commits: the two topics never land in one commit.
  git(dir, ['add', 'src-topic.ts']); git(dir, ['commit', '-m', 'feat: topic source'])
  writeFileSync(join(dir, 'docs-topic.md'), '# docs topic\n')
  git(dir, ['add', 'docs-topic.md']); git(dir, ['commit', '-m', 'docs: topic notes'])
  git(dir, ['add', 'src-topic.test.ts']); git(dir, ['commit', '-m', 'test: topic'])
  // Live dirty tree for the collector to read (all three topics dirty at once).
  writeFileSync(join(dir, 'src-topic.ts'), 'export const topic = 2\n')
  writeFileSync(join(dir, 'src-topic.test.ts'), 'import { topic } from "./src-topic"\nexpect(topic).toBe(2)\n')
  writeFileSync(join(dir, 'README.md'), '# fixture changed\n')
  return dir
}

/**
 * Capture the fixture's real git output up front, then serve it from a
 * recording fake — the seam under test only ever issues git reads.
 */
function recordedRun(dir: string): { run: GitRun; commands: string[] } {
  const commands = ['git status --porcelain', 'git diff --cached --numstat', 'git diff --numstat']
  const snapshot = new Map(commands.map(command =>
    [command, execFileSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8' })]))
  const issued: string[] = []
  return {
    commands: issued,
    run: async (command) => {
      issued.push(command)
      return { stdout: snapshot.get(command) ?? '' }
    },
  }
}

/** A fake runQuery returning canned text (or a failure reason) with a call log. */
function fakeQuery(text: string): { runQuery: never; callCount: () => number } {
  let calls = 0
  return {
    callCount: () => calls,
    runQuery: (async () => {
      calls += 1
      return { ok: true, text, inheritedRoute: false }
    }) as never,
  }
}

const invocation = { agent: { session: {} } } as unknown as CommandInvocation

const GROUPS_JSON = JSON.stringify([
  { message: 'feat: topic source', files: ['src-topic.ts'], dependencyEdges: [] },
  { message: 'test: topic', files: ['src-topic.test.ts'], dependencyEdges: ['test: topic → feat: topic source'] },
])

async function runWith(dir: string, modelText: string): Promise<{ text: string; commands: string[]; calls: number }> {
  const { run, commands } = recordedRun(dir)
  const fake = fakeQuery(modelText)
  const result = await commandCommitSplit.executeCommitSplit(
    new Context(), invocation, { run, runQuery: fake.runQuery },
  )
  return { text: result.kind === 'success' ? result.text ?? '' : JSON.stringify(result), commands, calls: fake.callCount() }
}

describe('/commit-split', () => {
  it('separates two interleaved topics and orders dependency-first', async () => {
    const { text, commands } = await runWith(fixture(), GROUPS_JSON)
    expect(text).toContain('feat: topic source')
    expect(text).toContain('test: topic')
    // `test → feat` edge: the dependency commits first.
    expect(text.indexOf('feat: topic source')).toBeLessThan(text.indexOf('test: topic'))
    expect(commands).toEqual([
      'git status --porcelain',
      'git diff --cached --numstat',
      'git diff --numstat',
    ])
  })

  it('ranks source above test above docs', async () => {
    // Model lists the groups back-to-front; the command re-orders them.
    const reversed = JSON.stringify([
      { message: 'docs: notes', files: ['README.md'], dependencyEdges: [] },
      { message: 'test: topic', files: ['src-topic.test.ts'], dependencyEdges: [] },
      { message: 'feat: topic source', files: ['src-topic.ts'], dependencyEdges: [] },
    ])
    const { text } = await runWith(fixture(), reversed)
    const order = ['feat: topic source', 'test: topic', 'docs: notes'].map(m => text.indexOf(m))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('lockfile-only change yields a single trailing chore(deps) group without touching the model', async () => {
    const dir = fixture()
    // Settle the fixture's dirty tree so pnpm-lock.yaml is the only change.
    git(dir, ['add', '-A']); git(dir, ['commit', '-m', 'settle'])
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    git(dir, ['add', 'pnpm-lock.yaml'])
    const lockOnly = JSON.stringify([{ message: 'bump deps', files: ['pnpm-lock.yaml'], dependencyEdges: [] }])
    const { text, calls } = await runWith(dir, lockOnly)
    expect(text).toContain(`1. ${DEPS_GROUP_MESSAGE}`)
    expect(text).toContain('pnpm-lock.yaml')
    expect(text).not.toContain('bump deps')
    expect(calls).toBe(0)
  })

  it('renders the pinned cycle error and no plan', async () => {
    const cyclic = JSON.stringify([
      { message: 'a', files: ['src-topic.ts'], dependencyEdges: ['a → b'] },
      { message: 'b', files: ['src-topic.test.ts'], dependencyEdges: ['b → a'] },
    ])
    const { text } = await runWith(fixture(), cyclic)
    expect(text).toBe('error: dependency cycle among groups: a → b → a')
  })

  it('renders the pinned schema error and no plan on malformed output', async () => {
    const { text } = await runWith(fixture(), 'here is my plan:\n1. commit everything')
    expect(text).toBe(SCHEMA_ERROR)
  })

  it('dry-run invariant: only git status/diff reads are issued, zero git commit', async () => {
    const { commands } = await runWith(fixture(), GROUPS_JSON)
    expect(commands.length).toBe(3)
    for (const command of commands) expect(command).toMatch(/^git (status|diff)/u)
    expect(commands.some(c => c.includes('commit'))).toBe(false)
  })

  it('registers a helpable command that answers the trailing help argument', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(commandCommitSplit)
    const definition = ctx.commands.find({ session: {} } as never, 'commit-split')
    expect(definition).toBeDefined()
    const result = await definition!.handler({
      agent: { session: {} },
      rawInput: 'help',
      attachments: [],
      signal: new AbortController().signal,
    } as unknown as CommandInvocation)
    expect(result.kind).toBe('success')
    expect(result.kind === 'success' && result.text).toContain('/commit-split — propose an ordered atomic-commit split')
  })
})
