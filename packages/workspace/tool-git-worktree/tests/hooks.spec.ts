/**
 * WS-6 hook-bridge adapter coverage (§8 WS-6 row): stdout-path adoption after
 * WS-1 verification (including the hook-created no-git-metadata acceptance
 * rule), exit≠0 → git-direct fallback, no-hook → default, and WorktreeRemove
 * replaced/kept decisions.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { HookOutput, HookRunResult } from '@dsh-cc/hook-protocol'
import { runWorktreeCreateHook, runWorktreeRemoveHook } from '../src/hooks.ts'
import { adoptionRefusal } from '../src/harden.ts'

const signal = new AbortController().signal

function out(partial: Partial<HookOutput>): HookOutput {
  return { exitCode: 0, stderr: '', stdout: '', ...partial }
}

function ctxWith(outputs: HookOutput[]): Context {
  return {
    get: () => async () => ({ decision: 'none', stop: false, additionalContext: [], systemMessages: [], outputs }),
  } as unknown as Context
}

const NO_HOOK: Context = {} as unknown as Context

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wt-hooks-'))
  return dir
}

/** A real registered worktree of a real repo (passes the WS-1 identity check). */
function realWorktree(): { mainRoot: string; worktreePath: string } {
  const root = tmp()
  const main = join(root, 'main')
  const wt = join(root, 'wt')
  execFileSync('git', ['init', '-q', main])
  writeFileSync(join(main, 'f'), 'x')
  execFileSync('git', ['-C', main, 'add', '.'])
  execFileSync('git', ['-C', main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  execFileSync('git', ['-C', main, 'worktree', 'add', '-b', 'side', wt])
  return { mainRoot: main, worktreePath: wt }
}

const fields = (worktreePath: string) => ({
  sessionId: 's1', cwd: '/x', name: 'demo', worktreePath, branch: 'worktree-demo', source: 'enter-worktree' as const,
})

describe('runWorktreeCreateHook', () => {
  it('adopts a hook stdout path that passes the WS-1 identity check', async () => {
    const { mainRoot, worktreePath } = realWorktree()
    try {
      const outcome = await runWorktreeCreateHook(ctxWith([out({ stdout: `${worktreePath}\n` })]), fields(worktreePath), { mainRoot, signal })
      expect(outcome).toEqual({ kind: 'adopt', path: worktreePath })
    } finally {
      rmSync(mainRoot, { recursive: true, force: true })
    }
  })

  it('falls back to git-direct creation when a hook exits non-zero', async () => {
    const { mainRoot, worktreePath } = realWorktree()
    try {
      const outcome = await runWorktreeCreateHook(ctxWith([out({ exitCode: 1 })]), fields(worktreePath), { mainRoot, signal })
      expect(outcome).toEqual({ kind: 'default' })
    } finally {
      rmSync(mainRoot, { recursive: true, force: true })
    }
  })

  it('falls back when no hook is mounted or no hook matched', async () => {
    const { mainRoot, worktreePath } = realWorktree()
    try {
      expect(await runWorktreeCreateHook(NO_HOOK, fields(worktreePath), { mainRoot, signal })).toEqual({ kind: 'default' })
      expect(await runWorktreeCreateHook(ctxWith([]), fields(worktreePath), { mainRoot, signal })).toEqual({ kind: 'default' })
    } finally {
      rmSync(mainRoot, { recursive: true, force: true })
    }
  })

  it('accepts a hook-created metadata-less directory only when no git repository contains it', async () => {
    const root = tmp()
    const mainRoot = join(root, 'main')
    const outside = join(root, 'hook-created')
    mkdirSync(mainRoot, { recursive: true })
    mkdirSync(outside)
    try {
      // The fake shell answers `git rev-parse --show-toplevel` with failure:
      // no git repository contains the directory.
      const noRepo = {
        ...ctxWith([out({ stdout: `${outside}\n` })]),
        shell: { resolve: (r: unknown) => r, run: async () => ({ exitCode: 128, stdout: { text: '' }, stderr: { text: '' }, aborted: false, signal: null, timedOut: false, timeoutMs: 1 }) },
      } as unknown as Context
      expect(adoptionRefusal(outside, mainRoot)).not.toBeNull() // metadata-less refusal exists…
      const outcome = await runWorktreeCreateHook(noRepo, fields(outside), { mainRoot, signal })
      expect(outcome).toEqual({ kind: 'adopt', path: outside }) // …but the no-repo rule accepts it
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a metadata-less directory that IS inside a git repository', async () => {
    const root = tmp()
    const mainRoot = join(root, 'main')
    const inside = join(root, 'hook-created')
    mkdirSync(mainRoot, { recursive: true })
    mkdirSync(inside)
    try {
      const inRepo = {
        ...ctxWith([out({ stdout: `${inside}\n` })]),
        shell: { resolve: (r: unknown) => r, run: async () => ({ exitCode: 0, stdout: { text: '/some/repo' }, stderr: { text: '' }, aborted: false, signal: null, timedOut: false, timeoutMs: 1 }) },
      } as unknown as Context
      const outcome = await runWorktreeCreateHook(inRepo, fields(inside), { mainRoot, signal })
      expect(outcome).toEqual({ kind: 'default' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('runWorktreeRemoveHook', () => {
  const removeFields = { sessionId: 's1', cwd: '/wt', worktreePath: '/wt', reason: 'exit' as const }

  it('reports default when no hook ran', async () => {
    expect(await runWorktreeRemoveHook(NO_HOOK, removeFields, signal)).toBe('default')
    expect(await runWorktreeRemoveHook(ctxWith([]), removeFields, signal)).toBe('default')
  })

  it('reports replaced when every hook exits 0', async () => {
    expect(await runWorktreeRemoveHook(ctxWith([out({}), out({ stdout: 'ok' })]), removeFields, signal)).toBe('replaced')
  })

  it('reports kept (tree stays) when any hook fails', async () => {
    expect(await runWorktreeRemoveHook(ctxWith([out({}), out({ exitCode: 2 })]), removeFields, signal)).toBe('kept')
    expect(await runWorktreeRemoveHook(ctxWith([out({ exitCode: undefined })]), removeFields, signal)).toBe('kept')
  })
})
