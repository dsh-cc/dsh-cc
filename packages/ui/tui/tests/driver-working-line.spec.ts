import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import { VERBS } from '@dsh-cc/tui/working-line.ts'

/**
 * Turn-anchor lifecycle for the working line: where `state.turn` is set
 * (plain submit, boot-into-running, event backstops, outbox flush re-anchor)
 * and where it is cleared (turn/end, interrupt, switchSession), plus the
 * tokenUsage rebase guard that pins an unseeded baseline without touching
 * startedAt/verbIndex — and never conjures a phantom anchor while idle.
 */

interface FakeAgent extends Record<string, unknown> {
  options: Record<string, unknown>
  session: { id: string; header: Record<string, unknown>; events: unknown[] }
  id: string
  status: string
  followup: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

function makeFakeAgent(sessionId: string, status: string): FakeAgent {
  return {
    options: {},
    session: { id: sessionId, header: {}, events: [], snapshotEvents() { return this.events } },
    id: `agent-${sessionId}`,
    status,
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  }
}

type ProjectionListener = (session: { id: string }, key: string, value: unknown, seq: number) => void

/** Fake sessionProjections service: hand-drivable change feed + stateOf (see driver-hud.spec.ts). */
function makeProjections(statesBySession: Record<string, Record<string, unknown>> = {}) {
  const listeners = new Set<ProjectionListener>()
  const service = {
    onChanged(listener: ProjectionListener): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    stateOf(session: { id: string }, key: string): unknown {
      return statesBySession[session.id]?.[key]
    },
  }
  const fire = (sessionId: string, key: string, value: unknown): void => {
    for (const listener of listeners) listener({ id: sessionId }, key, value, 0)
  }
  return { service, fire }
}

/**
 * Minimal ctx stub: captures session/event handlers (drivable via emitSession),
 * wires the projections service, and resolves create/resume to fake agents.
 */
function makeCtx(opts: {
  agent: FakeAgent
  projections?: ReturnType<typeof makeProjections>
  resumeSessions?: Record<string, { id: string; status: string }>
}) {
  const sessionHandlers = new Set<(session: unknown, event: unknown) => void>()
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      if (key === 'sessionProjections') return opts.projections?.service
      return undefined
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      if (event === 'session/event') {
        const fn = handler as (session: unknown, event: unknown) => void
        sessionHandlers.add(fn)
        return () => { sessionHandlers.delete(fn) }
      }
      return () => {}
    },
    agents: {
      create: async () => ({ agent: opts.agent, dispose: async () => {} }),
      resume: async (req: { resumeSessionId: string }) => {
        const s = opts.resumeSessions?.[req.resumeSessionId]
        if (s === undefined) throw new Error(`unknown session: ${req.resumeSessionId}`)
        return { agent: makeFakeAgent(s.id, s.status), dispose: async () => {} }
      },
    },
  }
  const emitSession = (event: unknown): void => {
    for (const handler of sessionHandlers) handler(opts.agent.session, event)
  }
  return { ctx, emitSession }
}

const usageState = (input: number, output: number) => ({
  totals: { uncachedInputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 },
  last: null,
})

const driverOpts = { cwd: '/w/proj', branchProbe: async () => undefined }

/** Let the microtask-deferred outbox flush (and its dispatch promises) settle. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('createDriver working-line turn anchors', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-workline-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('a plain submit anchors the turn with an unseeded baseline and a deterministic verb', async () => {
    const agent = makeFakeAgent('s-a', 'idle')
    const { ctx } = makeCtx({ agent })
    const driver = await createDriver(ctx as never, driverOpts)
    expect(driver.state.turn).toBeUndefined()

    await driver.submit('a plain prompt')
    expect(driver.state.busy).toBe(true)
    const turn = driver.state.turn
    expect(turn).toBeDefined()
    expect(turn!.startedAt).toBeGreaterThan(0)
    // No HUD seeded at submit time — the tokenUsage rebase pins it later.
    expect(turn!.outputBase).toBeUndefined()
    expect(turn!.verbIndex).toBe(turn!.startedAt % VERBS.length)
  })

  it('boot into a running session anchors after seeding the HUD (baseline reads the seeded tokens)', async () => {
    const projections = makeProjections({ 's-a': { tokenUsage: usageState(5000, 40) } })
    const agent = makeFakeAgent('s-a', 'running')
    const { ctx } = makeCtx({ agent, projections })

    const driver = await createDriver(ctx as never, driverOpts)
    expect(driver.state.busy).toBe(true)
    expect(driver.state.hud?.tokens).toEqual({ input: 5000, output: 40 })
    // Anchored from the seeded HUD, not an unseeded undefined baseline.
    expect(driver.state.turn?.outputBase).toBe(40)
    expect(driver.state.turn?.verbIndex).toBe(driver.state.turn!.startedAt % VERBS.length)
  })

  it('a live turn/start backstop anchors a turn the UI never saw submitted', async () => {
    const agent = makeFakeAgent('s-a', 'idle')
    const { ctx, emitSession } = makeCtx({ agent })
    const driver = await createDriver(ctx as never, driverOpts)
    expect(driver.state.turn).toBeUndefined()

    emitSession({ type: 'turn/start', data: {} })
    expect(driver.state.turn).toBeDefined()
    expect(driver.state.busy).toBe(true)
  })

  it('turn/end clears the anchor and leaves it cleared on an empty queue', async () => {
    const agent = makeFakeAgent('s-a', 'idle')
    const { ctx, emitSession } = makeCtx({ agent })
    const driver = await createDriver(ctx as never, driverOpts)

    await driver.submit('hello')
    expect(driver.state.turn).toBeDefined()
    const followupsAfterSubmit = agent.followup.mock.calls.length

    emitSession({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await settle()
    expect('turn' in driver.state).toBe(false)
    expect(driver.state.busy).toBe(false)
    // The submit itself dispatched once; the empty-queue flush adds nothing.
    expect(agent.followup.mock.calls.length).toBe(followupsAfterSubmit)
  })

  it('turn/end with a queued outbox flushes and re-anchors for the followup turn', async () => {
    const agent = makeFakeAgent('s-a', 'running')
    const { ctx, emitSession } = makeCtx({ agent })
    const driver = await createDriver(ctx as never, driverOpts)

    await driver.submit('one')
    expect(driver.state.queued).toEqual(['one'])

    emitSession({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await settle()
    // The flush dispatched the queued entry through followup...
    expect(agent.followup).toHaveBeenCalledOnce()
    expect(driver.state.queued).toEqual([])
    // ...and re-anchored the followup turn (clearTurn ran first, then flush).
    expect(driver.state.turn).toBeDefined()
    expect(driver.state.busy).toBe(true)
  })

  it('interrupt clears the anchor', async () => {
    const agent = makeFakeAgent('s-a', 'idle')
    const { ctx } = makeCtx({ agent })
    const driver = await createDriver(ctx as never, driverOpts)

    await driver.submit('long running work')
    expect(driver.state.turn).toBeDefined()

    driver.interrupt()
    expect('turn' in driver.state).toBe(false)
    expect(driver.state.busy).toBe(false)
  })

  it('switchSession clears the anchor on an idle target and re-anchors on a running one', async () => {
    const agent = makeFakeAgent('s-a', 'running')
    const { ctx } = makeCtx({
      agent,
      resumeSessions: {
        's-b': { id: 's-b', status: 'idle' },
        's-c': { id: 's-c', status: 'running' },
      },
    })
    const driver = await createDriver(ctx as never, driverOpts)
    // Boot into the running session anchors immediately.
    expect(driver.state.turn).toBeDefined()

    await driver.switchSession('s-b')
    expect('turn' in driver.state).toBe(false)
    expect(driver.state.busy).toBe(false)

    await driver.switchSession('s-c')
    expect(driver.state.turn).toBeDefined()
    expect(driver.state.busy).toBe(true)
    // The re-anchor belongs to the new session's (unseeded) HUD baseline.
    expect(driver.state.turn?.outputBase).toBeUndefined()
  })

  it('the first tokenUsage change pins the baseline without touching startedAt or verbIndex', async () => {
    const projections = makeProjections()
    const agent = makeFakeAgent('s-a', 'idle')
    const { ctx } = makeCtx({ agent, projections })
    const driver = await createDriver(ctx as never, driverOpts)

    await driver.submit('hello')
    const before = driver.state.turn!
    expect(before.outputBase).toBeUndefined()

    projections.fire('s-a', 'tokenUsage', usageState(1_000, 20))
    expect(driver.state.hud?.tokens).toEqual({ input: 1_000, output: 20 })
    // Pure baseline pin: startedAt/verbIndex are untouched.
    expect(driver.state.turn?.outputBase).toBe(20)
    expect(driver.state.turn?.startedAt).toBe(before.startedAt)
    expect(driver.state.turn?.verbIndex).toBe(before.verbIndex)
  })

  it('a tokenUsage event while idle never conjures a phantom anchor', async () => {
    const projections = makeProjections()
    const agent = makeFakeAgent('s-a', 'idle')
    const { ctx } = makeCtx({ agent, projections })
    const driver = await createDriver(ctx as never, driverOpts)

    projections.fire('s-a', 'tokenUsage', usageState(7, 8))
    // The HUD still folds, but no turn appears out of nowhere.
    expect(driver.state.hud?.tokens).toEqual({ input: 7, output: 8 })
    expect('turn' in driver.state).toBe(false)
  })
})

describe('createDriver working-line step clock (tool events reset the elapsed timer)', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-stepclock-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    vi.useRealTimers()
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('a tool/call resets the step clock, leaving startedAt and outputBase untouched', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(50_000)
    const projections = makeProjections()
    const agent = makeFakeAgent('s-a', 'idle')
    const { ctx, emitSession } = makeCtx({ agent, projections })
    const driver = await createDriver(ctx as never, driverOpts)

    await driver.submit('do work')
    expect(driver.state.turn?.startedAt).toBe(50_000)
    // Pin the baseline first so the assertion locks turn-cumulative tokens.
    projections.fire('s-a', 'tokenUsage', usageState(100, 50))
    expect(driver.state.turn?.outputBase).toBe(50)

    vi.setSystemTime(52_000)
    emitSession({ type: 'tool/call', data: { name: 'Bash', arguments: { command: 'ls' }, callId: 'c1' } })
    // The step clock moved; the turn anchor and the token baseline did not.
    expect(driver.state.turn?.stepStartedAt).toBe(52_000)
    expect(driver.state.turn?.startedAt).toBe(50_000)
    expect(driver.state.turn?.outputBase).toBe(50)
  })

  it('a tool/result resets the step clock too (the model is thinking once the tool finishes)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(50_000)
    const projections = makeProjections()
    const agent = makeFakeAgent('s-a', 'idle')
    const { ctx, emitSession } = makeCtx({ agent, projections })
    const driver = await createDriver(ctx as never, driverOpts)

    await driver.submit('do work')
    projections.fire('s-a', 'tokenUsage', usageState(100, 50))
    vi.setSystemTime(52_000)
    emitSession({ type: 'tool/call', data: { name: 'Bash', arguments: { command: 'ls' }, callId: 'c1' } })
    expect(driver.state.turn?.stepStartedAt).toBe(52_000)

    vi.setSystemTime(53_500)
    emitSession({ type: 'tool/result', data: { name: 'Bash', callId: 'c1', content: 'ok' } })
    expect(driver.state.turn?.stepStartedAt).toBe(53_500)
    expect(driver.state.turn?.startedAt).toBe(50_000)
    expect(driver.state.turn?.outputBase).toBe(50)
  })

  it('a tool event while idle never conjures a phantom anchor', async () => {
    const agent = makeFakeAgent('s-a', 'idle')
    const { ctx, emitSession } = makeCtx({ agent })
    const driver = await createDriver(ctx as never, driverOpts)
    expect(driver.state.turn).toBeUndefined()

    emitSession({ type: 'tool/call', data: { name: 'Bash', arguments: { command: 'ls' }, callId: 'c1' } })
    expect('turn' in driver.state).toBe(false)
  })

  it('the tokenUsage rebase pins the baseline without clobbering the step clock', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(50_000)
    const projections = makeProjections()
    const agent = makeFakeAgent('s-a', 'idle')
    const { ctx, emitSession } = makeCtx({ agent, projections })
    const driver = await createDriver(ctx as never, driverOpts)

    // Submit on an unseeded HUD: the anchor carries outputBase === undefined.
    await driver.submit('do work')
    expect(driver.state.turn?.outputBase).toBeUndefined()

    vi.setSystemTime(51_500)
    emitSession({ type: 'tool/call', data: { name: 'Bash', arguments: { command: 'ls' }, callId: 'c1' } })
    expect(driver.state.turn?.stepStartedAt).toBe(51_500)

    // The rebase must stay a pure baseline pin: outputBase pins, the step
    // clock survives untouched.
    projections.fire('s-a', 'tokenUsage', usageState(200, 70))
    expect(driver.state.turn?.outputBase).toBe(70)
    expect(driver.state.turn?.stepStartedAt).toBe(51_500)
    expect(driver.state.turn?.startedAt).toBe(50_000)
  })
})
