/**
 * WS-6 item 4 — EnterWorktree `path` form: inside-convention-dir adoption,
 * the outside always-ask (granted / rejected / no channel / bypassPermissions
 * skip), the from-within-a-worktree constraint, and the metadata-less
 * acceptance rule.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { resolveAdoptPath, resolvePathArgument } from '../src/pathform.ts'

const signal = new AbortController().signal

function realRepo(): { root: string; main: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pathform-'))
  const main = join(root, 'main')
  execFileSync('git', ['init', '-q', main])
  writeFileSync(join(main, 'f'), 'x')
  execFileSync('git', ['-C', main, 'add', '.'])
  execFileSync('git', ['-C', main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  return { root, main }
}

function fakeCtx(opts: { approval?: (reason: string) => string; revParseExit?: number } = {}): Context {
  return {
    get: (key: string) => key === 'approval' && opts.approval !== undefined
      ? { request: async (req: { reason?: string }) => opts.approval!(req.reason ?? '') }
      : undefined,
    fs: { lstat: async (p: string) => {
      try {
        const st = statSync(p)
        return { type: st.isDirectory() ? 'directory' : 'file' }
      } catch {
        return undefined
      }
    } },
    shell: {
      resolve: (r: unknown) => r,
      run: async () => ({
        exitCode: opts.revParseExit ?? 128, aborted: false, signal: null, timedOut: false, timeoutMs: 1,
        stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
      }),
    },
  } as unknown as Context
}

const exec = { signal, agent: { session: { snapshotEvents: () => [] } } } as never

describe('resolvePathArgument (within-worktree constraint)', () => {
  it('resolves repo-relative paths against the session cwd', () => {
    expect(resolvePathArgument('sub/dir', '/repo', null)).toBe('/repo/sub/dir')
  })

  it('refuses a path outside the worktrees dir from within a worktree session', () => {
    expect(() => resolvePathArgument('/elsewhere/wt', '/repo', '/repo')).toThrow(/must stay under/)
    expect(resolvePathArgument('/repo/.claude/worktrees/wt', '/repo', '/repo')).toBe('/repo/.claude/worktrees/wt')
  })
})

describe('resolveAdoptPath', () => {
  it('adopts a directory under .claude/worktrees directly (identity check) without any ask', async () => {
    const { root, main } = realRepo()
    try {
      const wt = join(main, '.claude', 'worktrees', 'existing')
      mkdirSync(wt, { recursive: true })
      execFileSync('git', ['-C', main, 'worktree', 'add', '-b', 'side', wt])
      let asked = 0
      const ctx = fakeCtx({ approval: () => { asked += 1; return 'allowed-once' } })
      const adopted = await resolveAdoptPath(ctx, exec, { rawPath: wt, cwd: main, repoRoot: main })
      expect(adopted).toBe(wt)
      expect(asked).toBe(0)
      void root
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ALWAYS asks for a path outside the convention dir; a grant adopts, a rejection refuses', async () => {
    const { root, main } = realRepo()
    try {
      const outside = join(root, 'outside-dir')
      mkdirSync(outside)
      const asks: string[] = []
      const granted = fakeCtx({ approval: (reason) => { asks.push(reason); return 'allowed-once' } })
      expect(await resolveAdoptPath(granted, exec, { rawPath: outside, cwd: main, repoRoot: main })).toBe(outside)
      expect(asks[0]).toMatch(/always fires/)

      const rejected = fakeCtx({ approval: () => 'rejected' })
      await expect(resolveAdoptPath(rejected, exec, { rawPath: outside, cwd: main, repoRoot: main }))
        .rejects.toThrow(/did not approve/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses when no approval channel exists (no silent adopt, no persistence to lean on)', async () => {
    const { root, main } = realRepo()
    try {
      const outside = join(root, 'outside-dir')
      mkdirSync(outside)
      await expect(resolveAdoptPath(fakeCtx(), exec, { rawPath: outside, cwd: main, repoRoot: main }))
        .rejects.toThrow(/no approval channel/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a non-existent path', async () => {
    const { root, main } = realRepo()
    try {
      await expect(resolveAdoptPath(fakeCtx(), exec, { rawPath: join(root, 'missing'), cwd: main, repoRoot: main }))
        .rejects.toThrow(/does not exist/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
