import { describe, expect, it } from 'vitest'
import {
  parseWorktreeListPorcelain,
  readWorktreeSettings,
  reuseResetDecision,
  resolveBaseRef,
  sweepDecision,
  sweepWorktrees,
  worktreeSettingsFromDocs,
  worktreeSettingsPaths,
  WORKTREE_DEFAULTS,
} from '../worktree-lifecycle.mjs'

describe('worktreeSettingsPaths (cascade mirror)', () => {
  it('mirrors user → project → local file paths', () => {
    const paths = worktreeSettingsPaths({ home: '/home/dsh', projectRoot: '/repo' })
    expect(paths).toEqual({
      user: '/home/dsh/settings.json',
      project: '/repo/.claude/settings.json',
      local: '/repo/.claude/settings.local.json',
    })
  })
})

describe('worktreeSettingsFromDocs (parity table vs settings-cascade)', () => {
  it('defaults survive when every layer is empty or unreadable', () => {
    expect(worktreeSettingsFromDocs([undefined, {}, undefined])).toEqual(WORKTREE_DEFAULTS)
    expect(WORKTREE_DEFAULTS).toEqual({ baseRef: 'fresh', cleanupPeriodDays: 30 })
  })

  it('higher precedence wins per key; lower keys still apply', () => {
    expect(worktreeSettingsFromDocs([
      { worktree: { baseRef: 'head', cleanupPeriodDays: 5 } },
      { worktree: { baseRef: 'fresh' } },
      { worktree: { cleanupPeriodDays: 90 } },
    ])).toEqual({ baseRef: 'fresh', cleanupPeriodDays: 90 })
  })

  it('ignores invalid values instead of failing', () => {
    expect(worktreeSettingsFromDocs([{ worktree: { baseRef: 'main', cleanupPeriodDays: 'x' } }]))
      .toEqual(WORKTREE_DEFAULTS)
  })
})

describe('readWorktreeSettings (fail-open file read)', () => {
  it('skips unreadable/unparseable files', () => {
    const read = (path) => {
      if (path === 'missing') throw new Error('ENOENT')
      if (path === 'garbage') return '{not json'
      return JSON.stringify({ worktree: { baseRef: 'head' } })
    }
    expect(readWorktreeSettings(
      { user: 'missing', project: 'garbage', local: 'ok.json' },
      read,
    )).toEqual({ baseRef: 'head', cleanupPeriodDays: 30 })
  })
})

describe('resolveBaseRef (fake git)', () => {
  const NOW = Date.parse('2026-09-14T00:00:00Z')

  it('head returns the literal HEAD with no probes', async () => {
    const calls = []
    expect(await resolveBaseRef((argv) => { calls.push(argv); return { status: 0, stdout: '' } }, 'head')).toBe('HEAD')
    expect(calls).toEqual([])
  })

  it('fresh with a 24h-fresh cache hits the cached ref (no fetch)', async () => {
    const calls = []
    const git = (argv) => { calls.push(argv); return { status: 0, stdout: argv[0] === 'symbolic-ref' ? 'refs/remotes/origin/main' : String(Math.floor(NOW / 1000)) } }
    expect(await resolveBaseRef(git, 'fresh', { now: NOW })).toBe('refs/remotes/origin/main')
    expect(calls.some(argv => argv[0] === 'fetch')).toBe(false)
  })

  it('fresh with a stale cache fetches the default branch (5s cap passed) and returns the cached ref', async () => {
    const stale = String(Math.floor((NOW - 25 * 60 * 60 * 1000) / 1000))
    const optsSeen = []
    const git = (argv, opts) => {
      if (argv[0] === 'symbolic-ref') return { status: 0, stdout: 'refs/remotes/origin/main' }
      if (argv[0] === 'reflog') return { status: 0, stdout: stale }
      if (argv[0] === 'fetch') { optsSeen.push(opts); return { status: 0, stdout: '' } }
      return { status: 0, stdout: '' }
    }
    expect(await resolveBaseRef(git, 'fresh', { now: NOW })).toBe('refs/remotes/origin/main')
    expect(optsSeen).toEqual([{ timeoutMs: 5000 }])
  })

  it('no remote at all falls back to HEAD', async () => {
    expect(await resolveBaseRef(() => ({ status: 128, stdout: '' }), 'fresh', { now: NOW })).toBe('HEAD')
  })

  it('a failing fetch still returns the cached ref (fallback chain)', async () => {
    const git = (argv) => {
      if (argv[0] === 'symbolic-ref') return { status: 0, stdout: 'refs/remotes/origin/main' }
      if (argv[0] === 'reflog') return { status: 0, stdout: '100' } // ancient
      if (argv[0] === 'fetch') return { status: 128, stdout: '' } // offline
      return { status: 0, stdout: '' }
    }
    expect(await resolveBaseRef(git, 'fresh', { now: NOW })).toBe('refs/remotes/origin/main')
  })

  it('an unreadable reflog counts as stale and attempts the refresh', async () => {
    let fetched = false
    const git = (argv) => {
      if (argv[0] === 'symbolic-ref') return { status: 0, stdout: 'refs/remotes/origin/main' }
      if (argv[0] === 'reflog') return { status: 1, stdout: '' }
      if (argv[0] === 'fetch') { fetched = true; return { status: 0, stdout: '' } }
      return { status: 0, stdout: '' }
    }
    await resolveBaseRef(git, 'fresh', { now: NOW })
    expect(fetched).toBe(true)
  })
})

// --- sweep -------------------------------------------------------------------

describe('parseWorktreeListPorcelain', () => {
  it('parses paths, branches, locks, and lock reasons', () => {
    const text = [
      'worktree /repo/.claude/worktrees/alpha',
      'HEAD abc',
      'branch refs/heads/worktree-alpha',
      '',
      'worktree /repo/.claude/worktrees/beta',
      'branch refs/heads/worktree-beta',
      'locked dsh-cc session beta',
      '',
      'worktree /repo/.claude/worktrees/gamma',
      'branch refs/heads/worktree-gamma',
      'locked',
      '',
    ].join('\n')
    expect(parseWorktreeListPorcelain(text)).toEqual([
      { path: '/repo/.claude/worktrees/alpha', branch: 'worktree-alpha', locked: false, lockReason: '' },
      { path: '/repo/.claude/worktrees/beta', branch: 'worktree-beta', locked: true, lockReason: 'dsh-cc session beta' },
      { path: '/repo/.claude/worktrees/gamma', branch: 'worktree-gamma', locked: true, lockReason: '' },
    ])
  })
})

const DAY = 24 * 60 * 60
const base = (over) => ({
  underConventionDir: true,
  ownedBranch: true,
  locked: false,
  lockReason: '',
  ageSeconds: 90 * DAY,
  dirty: false,
  unpushed: false,
  cleanupPeriodDays: 30,
  nowSeconds: 0,
  ...over,
})

describe('sweepDecision (decision table)', () => {
  it('removes a stale, clean, unpushed-checked, unlocked candidate', () => {
    expect(sweepDecision(base({}))).toBe('remove')
  })

  it('keeps young worktrees', () => {
    expect(sweepDecision(base({ ageSeconds: 5 * DAY }))).toBe('keep')
  })

  it('keeps locked worktrees but advises on stale dsh-cc locks', () => {
    expect(sweepDecision(base({ locked: true, lockReason: 'dsh-cc session beta' }))).toBe('advisory')
    expect(sweepDecision(base({ locked: true, lockReason: 'dsh-cc session beta', ageSeconds: 5 * DAY }))).toBe('keep')
    // foreign lock: never even advised
    expect(sweepDecision(base({ locked: true, lockReason: 'user session' }))).toBe('keep')
  })

  it('keeps dirty worktrees (fail-closed)', () => {
    expect(sweepDecision(base({ dirty: true }))).toBe('keep')
    expect(sweepDecision(base({ dirty: undefined }))).toBe('keep')
  })

  it('keeps unpushed worktrees (fail-closed)', () => {
    expect(sweepDecision(base({ unpushed: true }))).toBe('keep')
    expect(sweepDecision(base({ unpushed: undefined }))).toBe('keep')
  })

  it('keeps entries outside the convention dir or without an owned branch', () => {
    expect(sweepDecision(base({ underConventionDir: false }))).toBe('keep')
    expect(sweepDecision(base({ ownedBranch: false }))).toBe('keep')
  })
})

describe('sweepWorktrees (orchestration)', () => {
  const wt = (name, { locked = '', branch = `worktree-${name}`, status = '', unpushed = '', logAge = 90 * DAY } = {}) => {
    const path = `/repo/.claude/worktrees/${name}`
    return {
      listLine: ['worktree ' + path, 'branch refs/heads/' + branch, locked ? 'locked ' + locked : '', ''].join('\n'),
      path,
      // `null` simulates an unreadable probe (status 128).
      status,
      unpushed,
      logAge,
    }
  }
  const DAY_S = 24 * 60 * 60
  const NOW = 1_800_000_000
  const makeGit = (worktrees) => (argv, opts) => {
    if (argv[0] === 'worktree' && argv[1] === 'list') {
      return { status: 0, stdout: worktrees.map(w => w.listLine).join('') }
    }
    if (argv[0] === '-C' && argv[2] === 'log') {
      return { status: 0, stdout: String(NOW - worktrees.find(w => w.path === argv[1]).logAge) }
    }
    if (argv[0] === '-C' && argv[2] === 'status') {
      const w = worktrees.find(w => w.path === argv[1])
      return w.status === null ? { status: 128, stdout: '' } : { status: 0, stdout: w.status }
    }
    if (argv[0] === '-C' && argv[2] === 'rev-list') {
      const w = worktrees.find(w => w.path === argv[1])
      if (w.unpushed === undefined) return { status: 128, stdout: '' }
      return { status: 0, stdout: w.unpushed }
    }
    return { status: 0, stdout: '' }
  }

  it('removes a stale clean candidate and reports it', () => {
    const clean = wt('clean')
    const calls = []
    const git = (argv, opts) => {
      const r = makeGit([clean])(argv, opts)
      if (argv[0] === 'worktree' && argv[1] === 'remove') calls.push(argv)
      return r
    }
    const result = sweepWorktrees({
      repoRoot: '/repo',
      cleanupPeriodDays: 30,
      nowSeconds: NOW,
      git,
      onAdvisory: () => {},
    })
    expect(result.removed).toEqual([clean.path])
    expect(calls[0]).toContain('remove')
  })

  it('keeps dirty, unpushed, young, and unreadable candidates', () => {
    const worktrees = [
      wt('dirty', { status: ' M file\n' }),
      wt('unpushed', { unpushed: 'abc\n' }),
      wt('young', { logAge: 3 * DAY }),
      wt('unreadable', { status: null }),
    ]
    const result = sweepWorktrees({
      repoRoot: '/repo',
      cleanupPeriodDays: 30,
      nowSeconds: NOW,
      git: makeGit(worktrees),
      onAdvisory: () => {},
    })
    expect(result.removed).toEqual([])
    expect(result.advisories).toEqual([])
  })

  it('advises on stale dsh-cc locks without removing them', () => {
    const locked = wt('locked', { locked: 'dsh-cc session locked' })
    const advisories = []
    const calls = []
    const git = (argv, opts) => {
      if (argv[0] === 'worktree' && argv[1] === 'remove') calls.push(argv)
      return makeGit([locked])(argv, opts)
    }
    const result = sweepWorktrees({
      repoRoot: '/repo',
      cleanupPeriodDays: 30,
      nowSeconds: NOW,
      git,
      onAdvisory: line => advisories.push(line),
    })
    expect(result.removed).toEqual([])
    expect(result.advisories).toHaveLength(1)
    expect(result.advisories[0]).toContain('git worktree unlock')
    expect(calls).toEqual([])
  })

  it('is a silent no-op when worktree list fails', () => {
    const result = sweepWorktrees({
      repoRoot: '/repo',
      cleanupPeriodDays: 30,
      nowSeconds: NOW,
      git: () => ({ status: 128, stdout: '' }),
      onAdvisory: () => {},
    })
    expect(result).toEqual({ removed: [], advisories: [] })
  })
})

// --- reuse reset -------------------------------------------------------------

describe('reuseResetDecision (merged-reset rule)', () => {
  const ok = { source: 'name', clean: true, ownedBranch: true, ownCommits: 0, upstreamGone: false, mergedIntoFreshBase: undefined }

  it('resets a clean owned-branch tree with no own commits', () => {
    expect(reuseResetDecision(ok)).toBe('reset')
  })

  it('resets when the upstream is gone and all own commits merged into the fresh base', () => {
    expect(reuseResetDecision({ ...ok, ownCommits: 3, upstreamGone: true, mergedIntoFreshBase: true })).toBe('reset')
  })

  it('keeps the old tip on unmerged own commits or a live upstream', () => {
    expect(reuseResetDecision({ ...ok, ownCommits: 3, upstreamGone: false })).toBe('keep-tip')
    expect(reuseResetDecision({ ...ok, ownCommits: 3, upstreamGone: true, mergedIntoFreshBase: false })).toBe('keep-tip')
    expect(reuseResetDecision({ ...ok, ownCommits: 2, upstreamGone: undefined, mergedIntoFreshBase: undefined })).toBe('keep-tip')
  })

  it('fails closed on any unverifiable probe', () => {
    expect(reuseResetDecision({ ...ok, clean: undefined })).toBe('keep-tip')
    expect(reuseResetDecision({ ...ok, ownCommits: undefined })).toBe('keep-tip')
    expect(reuseResetDecision({ ...ok, ownedBranch: false })).toBe('keep-tip')
  })

  it('never resets a non-name source (WS-6 PR reuse skip)', () => {
    expect(reuseResetDecision({ ...ok, source: 'pr' })).toBe('keep-tip')
  })
})
