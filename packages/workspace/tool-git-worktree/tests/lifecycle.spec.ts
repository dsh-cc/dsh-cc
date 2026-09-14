import { describe, expect, it } from 'vitest'
import {
  isUnknownOptionFailure,
  lockWorktree,
  resolveBaseRef,
  sessionLockReason,
  unlockWorktree,
  DSH_CC_LOCK_PREFIX,
} from '../src/lifecycle.ts'
import { addWorktree } from '../src/worktree.ts'

describe('lock command construction (WS-4 sweep key)', () => {
  it('builds `git worktree lock --reason` at the repo root', () => {
    const cmd = lockWorktree('/repo', '/repo/.claude/worktrees/alpha', sessionLockReason('alpha'))
    expect(cmd.command).toBe("git worktree lock --reason='dsh-cc session alpha' '/repo/.claude/worktrees/alpha'")
    expect(cmd.workdir).toBe('/repo')
  })

  it('builds `git worktree unlock` at the repo root', () => {
    const cmd = unlockWorktree('/repo', '/repo/.claude/worktrees/alpha')
    expect(cmd.command).toBe("git worktree unlock '/repo/.claude/worktrees/alpha'")
    expect(cmd.workdir).toBe('/repo')
  })

  it('uses the dsh-cc lock prefix (general sweep ownership key)', () => {
    expect(sessionLockReason('alpha').startsWith(DSH_CC_LOCK_PREFIX)).toBe(true)
    expect(sessionLockReason('alpha')).toMatch(/^dsh-cc session /)
  })

  it('tolerates old-git unknown-option failures as a no-op', () => {
    expect(isUnknownOptionFailure("error: unknown option `reason'")).toBe(true)
    expect(isUnknownOptionFailure("error: unknown switch `e'")).toBe(true)
    expect(isUnknownOptionFailure('fatal: not a worktree')).toBe(false)
  })
})

describe('addWorktree base parameter', () => {
  it('defaults to the literal HEAD (legacy behavior)', () => {
    expect(addWorktree('/repo', 'alpha').command.endsWith('HEAD')).toBe(true)
  })

  it('takes a resolved base (fresh origin/HEAD ref)', () => {
    expect(addWorktree('/repo', 'alpha', [], 'refs/remotes/origin/main').command).toContain('refs/remotes/origin/main')
  })
})

describe('resolveBaseRef (fake runner)', () => {
  const NOW = Date.parse('2026-09-14T00:00:00Z')

  it('head returns the literal HEAD with no probes', async () => {
    const calls: string[][] = []
    const base = await resolveBaseRef({
      baseRef: 'head',
      git: async (argv) => { calls.push(argv); return { ok: true, stdout: '' } },
      now: NOW,
    })
    expect(base).toBe('HEAD')
    expect(calls).toEqual([])
  })

  it('fresh with a 24h-fresh cache hits the cached ref without fetching', async () => {
    const calls: string[][] = []
    const base = await resolveBaseRef({
      baseRef: 'fresh',
      git: async (argv) => {
        calls.push(argv)
        if (argv[0] === 'symbolic-ref') return { ok: true, stdout: 'refs/remotes/origin/main\n' }
        return { ok: true, stdout: String(Math.floor(NOW / 1000)) }
      },
      now: NOW,
    })
    expect(base).toBe('refs/remotes/origin/main')
    expect(calls.some(argv => argv[0] === 'fetch')).toBe(false)
  })

  it('fresh with a stale cache fetches the default branch and returns the cached ref', async () => {
    const stale = Math.floor((NOW - 25 * 60 * 60 * 1000) / 1000)
    const fetched: string[] = []
    let onFetch: string | undefined
    const base = await resolveBaseRef({
      baseRef: 'fresh',
      git: async (argv) => {
        if (argv[0] === 'symbolic-ref') return { ok: true, stdout: 'refs/remotes/origin/main' }
        if (argv[0] === 'reflog') return { ok: true, stdout: String(stale) }
        if (argv[0] === 'fetch') { fetched.push(argv.join(' ')); return { ok: true, stdout: '' } }
        return { ok: false, stdout: '' }
      },
      now: NOW,
      onFetch: (branch) => { onFetch = branch },
    })
    expect(base).toBe('refs/remotes/origin/main')
    expect(fetched).toEqual(['fetch origin main'])
    expect(onFetch).toBe('main')
  })

  it('no remote at all falls back to local HEAD', async () => {
    const base = await resolveBaseRef({
      baseRef: 'fresh',
      git: async () => ({ ok: false, stdout: '' }),
      now: NOW,
    })
    expect(base).toBe('HEAD')
  })

  it('a failing refresh fetch still returns the cached ref (fallback chain)', async () => {
    const base = await resolveBaseRef({
      baseRef: 'fresh',
      git: async (argv) => {
        if (argv[0] === 'symbolic-ref') return { ok: true, stdout: 'refs/remotes/origin/main' }
        if (argv[0] === 'reflog') return { ok: true, stdout: '100' } // ancient
        return { ok: false, stdout: '' } // fetch (and anything else) fails
      },
      now: NOW,
    })
    expect(base).toBe('refs/remotes/origin/main')
  })
})
