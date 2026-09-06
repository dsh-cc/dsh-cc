import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'

/**
 * F1 contract: the TUI permission-mode display and Shift+Tab cycle follow the
 * permission-rules engine's LIVE `defaultMode` (settings-merged), while a
 * durably recorded session mode (fold-beats-fallback) still wins, and the
 * literal-'default' fallback applies only when the service is absent.
 */

interface FakeSession {
  id: string
  header: Record<string, never>
  events: unknown[]
}

/** Stub `permissionRules` carrying a live defaultMode (the F1 surface). */
interface RulesStub {
  defaultMode?: string
  setMode?: (agent: unknown, mode: string) => void
}

function makeCtx(opts: {
  events?: unknown[]
  rules?: RulesStub
  resumeSessions?: Record<string, unknown[]>
} = {}): {
  ctx: Record<string, unknown>
  session: FakeSession
  fired: (type: string, event: unknown) => void
} {
  const session: FakeSession = { id: 's-a', header: {}, events: opts.events ?? [] }
  const listeners = new Map<string, ((s: FakeSession, event: unknown) => void)[]>()
  const makeAgent = (s: FakeSession): Record<string, unknown> => ({
    options: {},
    session: { id: s.id, header: { cwd: '/proj' }, events: s.events },
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
      if (key === 'permissionRules') return opts.rules
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
      resume: async (req: { resumeSessionId: string }) => {
        const events = opts.resumeSessions?.[req.resumeSessionId]
        if (events === undefined) throw new Error(`unknown session: ${req.resumeSessionId}`)
        return { agent: makeAgent({ ...session, id: req.resumeSessionId, events }), dispose: async () => {} }
      },
    },
  }
  const fired = (type: string, event: unknown): void => {
    for (const fn of listeners.get(type) ?? []) fn(session, event)
  }
  return { ctx, session, fired }
}

describe('createDriver live defaultMode display (F1)', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-default-mode-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('(a) boot renders the service defaultMode ("auto") when no fold exists', async () => {
    const { ctx } = makeCtx({ rules: { defaultMode: 'auto' } })
    const driver = await createDriver(ctx as never, {})
    expect(driver.state.permissionMode).toBe('auto')
  })

  it('(b) fold-beats-fallback: a recorded session mode wins over settings defaultMode (session switch)', async () => {
    const { ctx } = makeCtx({
      rules: { defaultMode: 'auto' },
      events: [{ type: 'permission/mode', data: { mode: 'acceptEdits' } }], // recorded 'acceptEdits' on the boot session
      resumeSessions: {
        's-a': [{ type: 'permission/mode', data: { mode: 'acceptEdits' } }],
        's-b': [],
      },
    })
    const driver = await createDriver(ctx as never, {})
    expect(driver.state.permissionMode).toBe('acceptEdits')
    // Switching to a session with NO recorded mode falls back to the service
    // default, while the recorded one is re-derived from the fold on s-a.
    await driver.switchSession('s-b')
    expect(driver.state.permissionMode).toBe('auto')
    await driver.switchSession('s-a')
    expect(driver.state.permissionMode).toBe('acceptEdits')
  })

  it('(b2) the session/event re-emit keeps the fold precedence over the service default', async () => {
    const { ctx, fired } = makeCtx({
      rules: { defaultMode: 'auto' },
      events: [{ type: 'permission/mode', data: { mode: 'acceptEdits' } }],
    })
    const driver = await createDriver(ctx as never, {})
    fired('session/event', { type: 'permission/mode', data: { mode: 'acceptEdits' } })
    expect(driver.state.permissionMode).toBe('acceptEdits')
  })

  it('(c) Shift+Tab cycle starts from a cycle-member service defaultMode', async () => {
    const setMode = vi.fn()
    const { ctx } = makeCtx({ rules: { defaultMode: 'default', setMode } })
    const driver = await createDriver(ctx as never, {})
    await driver.cyclePermissionMode()
    // default → acceptEdits (the first cycle step from the service default).
    expect(setMode).toHaveBeenCalledWith(expect.anything(), 'acceptEdits')
  })

  it('(c2) a non-member defaultMode is clamped to "default" before cycling', async () => {
    const setMode = vi.fn()
    const { ctx } = makeCtx({ rules: { defaultMode: 'yolo', setMode } })
    const driver = await createDriver(ctx as never, {})
    await driver.cyclePermissionMode()
    // Uncamp: nextPermissionMode('yolo') would resolve to list[0] 'default'
    // and applyMode('default') — the clamp must start the cycle at 'default'
    // so the first press produces 'acceptEdits' instead.
    expect(setMode).toHaveBeenCalledWith(expect.anything(), 'acceptEdits')
    // ...and never cycles from the literal 'default'.
    expect(setMode).not.toHaveBeenCalledWith(expect.anything(), 'default')
  })

  it('(e) absent permissionRules service keeps the literal "default" everywhere', async () => {
    const { ctx } = makeCtx()
    const driver = await createDriver(ctx as never, {})
    expect(driver.state.permissionMode).toBe('default')
    await driver.cyclePermissionMode()
    // Cycle with no recorded mode (starting at the fallback) hits the
    expect(driver.state.notice).toBe('The permission-rules engine is not mounted in this composition.')
  })
})
