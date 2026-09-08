import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'

/**
 * R4 contract: a LIVE-appended `permission/classifier` event carrying
 * `failure: 'breaker'` surfaces ONE user-visible notice per session in this
 * process. Replayed/initial-fold log events never re-show it (a resume must
 * not re-notice a long-fixed lane).
 */

interface FakeSession {
  id: string
  header: Record<string, never>
  events: unknown[]
}

function makeCtx(opts: { events?: unknown[] } = {}): {
  ctx: Record<string, unknown>
  session: FakeSession
  fired: (type: string, event: unknown) => void
} {
  const session: FakeSession = { id: 's-a', header: {}, events: opts.events ?? [] , snapshotEvents() { return this.events } }
  const listeners = new Map<string, ((s: FakeSession, event: unknown) => void)[]>()
  const makeAgent = (s: FakeSession): Record<string, unknown> => ({
    options: {},
    session: { id: s.id, header: { cwd: '/proj' }, events: s.events , snapshotEvents() { return this.events } },
    id: `agent-${s.id}`,
    status: 'idle',
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  })
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      if (key === 'sessionPersistence') {
        return { list: async () => [] }
      }
      return undefined
    },
    on: (type: string, fn: (s: FakeSession, event: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
      return () => {}
    },
    agents: {
      create: async () => ({
        agent: makeAgent(session),
        dispose: async () => {},
      }),
    },
  }
  const fired = (type: string, event: unknown): void => {
    for (const fn of listeners.get(type) ?? []) fn(session, event)
  }
  return { ctx, session, fired }
}

const breakerEvent = { type: 'permission/classifier', data: { tool: 'Bash', verdict: 'ask', failure: 'breaker' } }

describe('createDriver classifier-breaker notice (R4)', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-breaker-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('a live breaker event surfaces the fallback notice once', async () => {
    const { ctx, fired } = makeCtx()
    const driver = await createDriver(ctx as never, {})
    let prev: string | undefined
    const shows: string[] = []
    driver.subscribe((state) => {
      if (state.notice?.includes('classifier lane failed repeatedly') && prev !== state.notice) shows.push(state.notice)
      prev = state.notice
    })
    fired('session/event', breakerEvent)
    expect(driver.state.notice).toBe('classifier lane failed repeatedly; auto mode continues without LLM vetting until settings change')
    // De-dup: a second breaker event in the same session does not re-show.
    fired('session/event', breakerEvent)
    expect(shows).toHaveLength(1)
  })

  it('replayed/initial-fold breaker events never re-show the notice', async () => {
    const { ctx, fired } = makeCtx({ events: [breakerEvent] })
    const driver = await createDriver(ctx as never, {})
    fired('session/event', { type: 'permission/classifier', data: { tool: 'Bash', verdict: 'ask', failure: 'malformed' } })
    expect(driver.state.notice).toBeUndefined()
  })
})
