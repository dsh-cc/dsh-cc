import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { readResumeTarget, writeResumeTarget } from '@dsh-cc/tui/resume-target.ts'
import {
  resumedCwdGuard,
  gateAutoResumeTarget,
  tombstoneResumeTargetForRemovedWorktree,
  warnIfResumedCwdMissing,
} from '@dsh-cc/tui/src/harness/resumed-cwd-guard.ts'
import type { PersistenceLike } from '@dsh-cc/tui/src/harness/session-service-likes.ts'

/**
 * Minimal agent face over a real event-sourced Session, with an explicit
 * header cwd (same duck-typed idiom as packages/workspace/session-cwd/tests/api.spec.ts:12-23).
 */
function agent(headerCwd?: string): Agent {
  const session = Session.create(SessionId(`guard-${Math.random()}`))
  const fake = {
    session: {
      id: session.id,
      seq: 0 as number,
      snapshotEvents: (): readonly unknown[] => session.snapshotEvents(),
      eventAt: (i: number): unknown => session.eventAt(i),
      append: session.append.bind(session),
      header: headerCwd === undefined ? {} : { cwd: headerCwd },
    },
  }
  return fake as unknown as Agent
}

/** Append a durable `worktree/entered` fold event (raw wire shape). */
function enterWorktree(a: Agent, path: string): void {
  const session = (a as unknown as { session: { append: (e: unknown) => void } }).session
  session.append('worktree/entered' as never, { path } as never)
}

describe('resumedCwdGuard', () => {
  it('returns undefined for an existing session cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-ok-'))
    try {
      expect(resumedCwdGuard(agent(dir), '/launch')).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns the path when the header cwd no longer exists', () => {
    const missing = join(tmpdir(), 'guard-gone-does-not-exist')
    const guard = resumedCwdGuard(agent(missing), '/launch')
    expect(guard).toEqual({ missingCwd: missing })
  })

  it('a worktree/entered fold overrides the header cwd (both directions)', () => {
    const live = mkdtempSync(join(tmpdir(), 'guard-live-'))
    try {
      // Header cwd is gone, but the fold moved the session into an existing dir.
      const moved = agent(join(tmpdir(), 'guard-gone-header'))
      enterWorktree(moved, live)
      expect(resumedCwdGuard(moved, '/launch')).toBeUndefined()
    } finally {
      rmSync(live, { recursive: true, force: true })
    }
    // Fold moved the session into a deleted dir even though the header exists.
    const existing = mkdtempSync(join(tmpdir(), 'guard-header-'))
    try {
      const dead = agent(existing)
      enterWorktree(dead, join(tmpdir(), 'guard-gone-fold'))
      expect(resumedCwdGuard(dead, '/launch')).toEqual({
        missingCwd: join(tmpdir(), 'guard-gone-fold'),
      })
    } finally {
      rmSync(existing, { recursive: true, force: true })
    }
  })

  it('falls back to the launch cwd when the header cwd is absent', () => {
    const launch = mkdtempSync(join(tmpdir(), 'guard-launch-'))
    try {
      expect(resumedCwdGuard(agent(), launch)).toBeUndefined()
      expect(resumedCwdGuard(agent(), join(tmpdir(), 'guard-launch-gone'))).toEqual({
        missingCwd: join(tmpdir(), 'guard-launch-gone'),
      })
    } finally {
      rmSync(launch, { recursive: true, force: true })
    }
  })
})

describe('warnIfResumedCwdMissing', () => {
  it('emits no notice when the cwd exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'warn-ok-'))
    try {
      const notices: string[] = []
      warnIfResumedCwdMissing(agent(dir), '/launch', (m) => notices.push(m))
      expect(notices).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('emits a Chinese notice naming the missing directory', () => {
    const missing = join(tmpdir(), 'warn-gone-dir')
    const notices: string[] = []
    warnIfResumedCwdMissing(agent(missing), '/launch', (m) => notices.push(m))
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain(missing)
    expect(notices[0]).toContain('/clear')
  })
})

/**
 * Tombstone semantics: when a worktree is removed, the project-level resume
 * anchor must be cleared if (and only if) the anchored session lived under
 * the removed path. DSH_HOME is pinned per test (resume-target has no
 * injection point, same idiom as driver-resume-marker.spec.ts).
 */
describe('tombstoneResumeTargetForRemovedWorktree', () => {
  let prevHome: string | undefined
  let tempHome: string
  let tempCwd: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-tombstone-'))
    process.env.DSH_HOME = tempHome
    tempCwd = mkdtempSync(join(tmpdir(), 'dsh-tombstone-cwd-'))
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(tempHome, { recursive: true, force: true })
    rmSync(tempCwd, { recursive: true, force: true })
  })

  /** Structural PersistenceLike over plain header snapshots. */
  function persistence(snapshots: Array<{ id: string; cwd?: string }>): PersistenceLike {
    return {
      list: async () =>
        snapshots.map((s) => ({
          header: { id: s.id, createdAt: 0, ...(s.cwd === undefined ? {} : { cwd: s.cwd }) },
          revision: null,
        })),
    }
  }

  it('clears the anchor when the anchored session cwd is inside the removed worktree', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'dsh-wt-'))
    try {
      writeResumeTarget('s-1', { cwd: tempCwd })
      const result = await tombstoneResumeTargetForRemovedWorktree({
        cwd: tempCwd,
        removedPath: worktree,
        persistence: persistence([{ id: 's-1', cwd: join(worktree, 'packages', 'ui') }]),
      })
      expect(result).toEqual({ cleared: true, sessionId: 's-1' })
      expect(readResumeTarget({ cwd: tempCwd })).toBeUndefined()
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  })

  it('keeps the anchor when the session cwd is the main root or another worktree', async () => {
    writeResumeTarget('s-1', { cwd: tempCwd })
    const persistenceWith = tombstoneResumeTargetForRemovedWorktree
    const other = mkdtempSync(join(tmpdir(), 'dsh-wt-other-'))
    try {
      for (const cwd of ['/repo-main-root', other]) {
        const result = await persistenceWith({
          cwd: tempCwd,
          removedPath: join(tempCwd, '.worktrees', 'pr-7'),
          persistence: persistence([{ id: 's-1', cwd }]),
        })
        expect(result).toEqual({ cleared: false })
        expect(readResumeTarget({ cwd: tempCwd })).toBe('s-1')
      }
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('is a no-op without an anchor', async () => {
    const result = await tombstoneResumeTargetForRemovedWorktree({
      cwd: '/repo',
      removedPath: join(tempCwd, '.worktrees', 'pr-7'),
      persistence: persistence([{ id: 's-1', cwd: join(tempCwd, '.worktrees', 'pr-7') }]),
    })
    expect(result).toEqual({ cleared: false })
  })

  it('fails open when persistence is undefined, throws, or lacks the snapshot/cwd', async () => {
    writeResumeTarget('s-1', { cwd: tempCwd })
    const removedPath = join(tempCwd, '.worktrees', 'pr-7')
    const base = { cwd: tempCwd, removedPath }
    expect(await tombstoneResumeTargetForRemovedWorktree({ ...base })).toEqual({ cleared: false })
    expect(await tombstoneResumeTargetForRemovedWorktree({
      ...base,
      persistence: { list: async () => { throw new Error('boom') } },
    })).toEqual({ cleared: false })
    expect(await tombstoneResumeTargetForRemovedWorktree({
      ...base,
      persistence: persistence([{ id: 's-other', cwd: removedPath }]),
    })).toEqual({ cleared: false })
    expect(await tombstoneResumeTargetForRemovedWorktree({
      ...base,
      persistence: persistence([{ id: 's-1', cwd: undefined }]),
    })).toEqual({ cleared: false })
    expect(readResumeTarget({ cwd: tempCwd })).toBe('s-1')
  })

  it('respects segment boundaries (bar vs barbaz) and normalizes relative/trailing-slash paths', async () => {
    writeResumeTarget('s-1', { cwd: tempCwd })
    expect(await tombstoneResumeTargetForRemovedWorktree({
      cwd: tempCwd,
      removedPath: join(tempCwd, '.worktrees', 'bar'),
      persistence: persistence([{ id: 's-1', cwd: join(tempCwd, '.worktrees', 'barbaz', 'x') }]),
    })).toEqual({ cleared: false })

    const result = await tombstoneResumeTargetForRemovedWorktree({
      cwd: tempCwd,
      removedPath: join(tempCwd, '.worktrees', 'bar') + '/',
      persistence: persistence([{ id: 's-1', cwd: join(tempCwd, '.worktrees', 'bar', 'src') }]),
    })
    expect(result).toEqual({ cleared: true, sessionId: 's-1' })
  })
})

/**
 * Boot gate: auto-resume degrades to a fresh session (clearing the anchor,
 * with a Chinese notice) when the anchored session's persisted cwd no longer
 * exists; any fail-open case resumes untouched.
 */
describe('gateAutoResumeTarget', () => {
  let prevHome: string | undefined
  let tempHome: string
  let tempCwd: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-gate-'))
    tempCwd = mkdtempSync(join(tmpdir(), 'dsh-gate-cwd-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(tempHome, { recursive: true, force: true })
    rmSync(tempCwd, { recursive: true, force: true })
  })

  function persistence(snapshots: Array<{ id: string; cwd?: string }>): PersistenceLike {
    return {
      list: async () =>
        snapshots.map((s) => ({
          header: { id: s.id, createdAt: 0, ...(s.cwd === undefined ? {} : { cwd: s.cwd }) },
          revision: null,
        })),
    }
  }

  it('degrades to fresh + clears the anchor + notices when the cwd is missing', async () => {
    writeResumeTarget('s-1', { cwd: tempCwd })
    const missing = join(tempHome, 'gone-dir')
    const notices: string[] = []
    const result = await gateAutoResumeTarget({
      markerId: 's-1',
      persistence: persistence([{ id: 's-1', cwd: missing }]),
      showNotice: (m) => notices.push(m),
      cwd: tempCwd,
    })
    expect(result).toBe('fresh')
    expect(readResumeTarget({ cwd: tempCwd })).toBeUndefined()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain(missing)
    expect(notices[0]).toContain('已开启新会话')
  })

  it('resumes with no side effects when the cwd still exists', async () => {
    writeResumeTarget('s-1', { cwd: tempCwd })
    const existing = mkdtempSync(join(tmpdir(), 'dsh-gate-live-'))
    try {
      const notices: string[] = []
      const result = await gateAutoResumeTarget({
        markerId: 's-1',
        persistence: persistence([{ id: 's-1', cwd: existing }]),
        showNotice: (m) => notices.push(m),
        cwd: tempCwd,
      })
      expect(result).toBe('resume')
      expect(notices).toEqual([])
      expect(readResumeTarget({ cwd: tempCwd })).toBe('s-1')
    } finally {
      rmSync(existing, { recursive: true, force: true })
    }
  })

  it('fails open to resume when persistence is undefined, throws, or lacks the snapshot/cwd', async () => {
    writeResumeTarget('s-1', { cwd: tempCwd })
    const base = { markerId: 's-1', showNotice: () => {}, cwd: tempCwd }
    expect(await gateAutoResumeTarget({ ...base })).toBe('resume')
    expect(await gateAutoResumeTarget({
      ...base,
      persistence: { list: async () => { throw new Error('boom') } },
    })).toBe('resume')
    expect(await gateAutoResumeTarget({
      ...base,
      persistence: persistence([{ id: 's-other', cwd: '/whatever' }]),
    })).toBe('resume')
    expect(await gateAutoResumeTarget({
      ...base,
      persistence: persistence([{ id: 's-1', cwd: undefined }]),
    })).toBe('resume')
    expect(readResumeTarget({ cwd: tempCwd })).toBe('s-1')
  })
})
