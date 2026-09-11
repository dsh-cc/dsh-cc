import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resumedCwdGuard, warnIfResumedCwdMissing } from '@dsh-cc/tui/src/harness/resumed-cwd-guard.ts'

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
