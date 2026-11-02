import { describe, expect, it } from 'vitest'
import { realpathSync } from 'node:fs'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { getSessionCwd, resolveSessionCwd } from '../src/api.ts'
import { WORKTREE_ENTERED_EVENT } from '../src/events.ts'
import { serviceRig, tempDir } from './rig.ts'

/** Fake agent over a real Session, with an explicit header cwd. */
function fakeAgent(headerCwd?: string): Agent {
  const session = Session.create(SessionId(`api-${Math.random()}`))
  const face = {
    session: {
      id: session.id,
      seq: 0 as number,
      snapshotEvents: (): readonly unknown[] => session.snapshotEvents(),
      eventAt: (i: number): unknown => session.eventAt(i),
      append: session.append.bind(session),
      header: headerCwd === undefined ? {} : { cwd: headerCwd },
    },
  }
  return face as unknown as Agent
}

/** Append a legacy cwd event through the widened wire face (no writer API). */
function appendEntered(agent: Agent, path: string): void {
  ;(agent.session.append as unknown as (type: string, payload: { path: string }) => void)(WORKTREE_ENTERED_EVENT, { path })
}

/** A fake agent whose ctx resolves the given services by name. */
function agentWithCtx(services: Record<string, unknown>, headerCwd?: string): Agent {
  const agent = fakeAgent(headerCwd)
  ;(agent as unknown as { ctx: unknown }).ctx = {
    get: (name: string): unknown => services[name],
  }
  return agent
}

describe('legacy fallback (service absent)', () => {
  it('folds worktree/entered over the header cwd', () => {
    const agent = fakeAgent('/tmp/header')
    appendEntered(agent, '/tmp/worktree')
    expect(resolveSessionCwd(agent)).toBe('/tmp/worktree')
  })

  it('falls back to the header cwd for an empty log', () => {
    expect(resolveSessionCwd(fakeAgent('/tmp/header'))).toBe('/tmp/header')
  })

  it('returns undefined when nothing records a cwd', () => {
    expect(resolveSessionCwd(fakeAgent())).toBeUndefined()
  })

  it('never throws for an agent without a ctx', () => {
    expect(() => resolveSessionCwd(fakeAgent())).not.toThrow()
  })

  it('falls back to the caller fallback, then the process cwd', () => {
    const agent = fakeAgent()
    expect(getSessionCwd(agent, { fallback: '/tmp/fallback' })).toBe('/tmp/fallback')
    expect(getSessionCwd(agent)).toBe(process.cwd())
  })
})

describe('service-backed resolution (unit faces)', () => {
  it('treats a registered projection state as authoritative over the legacy fold', () => {
    const agent = agentWithCtx({
      workingDirectory: {},
      sessionProjections: { stateOf: (): unknown => null },
    }, '/tmp/header')
    appendEntered(agent, '/tmp/worktree')
    expect(resolveSessionCwd(agent)).toBeUndefined()
  })

  it('reads the projected string state', () => {
    const agent = agentWithCtx({
      workingDirectory: {},
      sessionProjections: { stateOf: (): unknown => '/tmp/projected' },
    })
    appendEntered(agent, '/tmp/worktree')
    expect(resolveSessionCwd(agent)).toBe('/tmp/projected')
  })

  it('falls back to the legacy fold when the projection key is unregistered', () => {
    const agent = agentWithCtx({
      workingDirectory: {},
      sessionProjections: { stateOf: (): unknown => undefined },
    })
    appendEntered(agent, '/tmp/worktree')
    expect(resolveSessionCwd(agent)).toBe('/tmp/worktree')
  })
})

describe('service-backed resolution (real rig)', () => {
  it('reports the header cwd for a fresh session', async () => {
    const rig = await serviceRig()
    const ws = tempDir()
    const session = rig.session(ws)
    const agent = rig.agent(session)
    expect(resolveSessionCwd(agent)).toBe(ws)
    expect(getSessionCwd(agent)).toBe(ws)
    expect(rig.service.get(session)).toBe(ws)
  })

  it('reports the canonical path after a committed set and logs the native event', async () => {
    const rig = await serviceRig()
    const ws = tempDir('session-cwd-ws-')
    const target = tempDir('session-cwd-moved-')
    const session = rig.session(ws)
    const agent = rig.agent(session)
    const committed = await rig.service.set(agent, target)
    const canonical = realpathSync(target)
    expect(committed).toBe(canonical)
    expect(resolveSessionCwd(agent)).toBe(canonical)
    expect(getSessionCwd(agent)).toBe(canonical)
    const events = session.snapshotEvents() as unknown as { type: string; data?: { cwd?: string } }[]
    expect(events.filter(event => event.type === 'working-directory/change').at(-1)?.data?.cwd).toBe(canonical)
  })

  it('treats a registered null state as authoritative over a legacy fold', async () => {
    const rig = await serviceRig()
    const session = rig.session()
    appendEntered(rig.agent(session), '/tmp/legacy-worktree')
    expect(resolveSessionCwd(rig.agent(session))).toBeUndefined()
  })
})
