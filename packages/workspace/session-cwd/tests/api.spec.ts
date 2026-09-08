import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { getSessionCwd, setSessionCwd } from '../src/api.ts'
import { SessionCwdStore } from '../src/state.ts'
import { foldSessionCwd } from '../src/events.ts'

/**
 * A minimal agent face over a real event-sourced Session, with an explicit
 * header cwd (the real header is derived from the boot route, not writable).
 */
function agent(headerCwd?: string, store = new SessionCwdStore()): Agent {
  const session = Session.create(SessionId(`api-${Math.random()}`))
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

describe('setSessionCwd', () => {
  it('appends a durable worktree/entered event with the normalized path', () => {
    const a = agent()
    setSessionCwd(a, '/tmp/wt/sub/../deep')
    expect(foldSessionCwd(a.session.snapshotEvents())).toBe('/tmp/wt/deep')
  })

  it('updates the store overlay for that session only', () => {
    const store = new SessionCwdStore()
    const a = agent(undefined, store)
    const options = { store }
    setSessionCwd(a, '/tmp/one', options)
    expect(store.get(String(a.session.id))).toBe('/tmp/one')
  })

  it('records a restore back to the original directory the same way', () => {
    const a = agent()
    setSessionCwd(a, '/tmp/wt')
    setSessionCwd(a, '/tmp/origin')
    expect(getSessionCwd(a)).toBe('/tmp/origin')
  })

  it('rejects relative paths', () => {
    const a = agent()
    expect(() => setSessionCwd(a, 'relative/path')).toThrow(TypeError)
    expect(() => setSessionCwd(a, 'relative/path')).toThrow(/absolute/)
  })
})

describe('getSessionCwd', () => {
  it('reads back the value written by setSessionCwd', () => {
    const a = agent()
    setSessionCwd(a, '/tmp/session')
    expect(getSessionCwd(a)).toBe('/tmp/session')
  })

  it('falls back to the session header cwd when nothing was recorded', () => {
    const a = agent('/tmp/header')
    expect(getSessionCwd(a)).toBe('/tmp/header')
  })

  it('prefers the folded event cwd over the header cwd', () => {
    const a = agent('/tmp/header')
    setSessionCwd(a, '/tmp/worktree')
    expect(getSessionCwd(a)).toBe('/tmp/worktree')
  })

  it('falls back to the caller fallback, then the process cwd', () => {
    const a = agent()
    expect(getSessionCwd(a, { fallback: '/tmp/fallback' })).toBe('/tmp/fallback')
    expect(getSessionCwd(a)).toBe(process.cwd())
  })
})
