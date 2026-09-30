import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import { markReleasing, resetReleasedMarkers } from '@dsh-cc/command-agents/release'

/**
 * Minimal ctx stub that captures `session/event`, `subagent/start`, and
 * `subagent/end` handlers so tests can drive the live lifecycle fold. The
 * agent exposes followup/steer/cancel spies so submit routing is observable
 * without a real harness. Subagent events are global (process-scoped), so
 * the handlers receive a single payload — no session filter.
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

function makeFakeAgent(): FakeAgent {
  return {
    options: {},
    session: { id: 's-sub', header: {}, events: [], snapshotEvents() { return this.events } },
    id: 'a-sub',
    status: 'idle',
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  }
}

function makeCtx(agent: FakeAgent, children: Record<string, unknown> = {}) {
  const sessionHandlers = new Set<(session: unknown, event: unknown) => void>()
  const startHandlers = new Set<(info: unknown) => void>()
  const endHandlers = new Set<(info: unknown) => void>()
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      return undefined
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      if (event === 'session/event') {
        const fn = handler as (session: unknown, event: unknown) => void
        sessionHandlers.add(fn)
        return () => { sessionHandlers.delete(fn) }
      }
      if (event === 'subagent/start') {
        const fn = handler as (info: unknown) => void
        startHandlers.add(fn)
        return () => { startHandlers.delete(fn) }
      }
      if (event === 'subagent/end') {
        const fn = handler as (info: unknown) => void
        endHandlers.add(fn)
        return () => { endHandlers.delete(fn) }
      }
      return () => {}
    },
    agents: {
      create: async () => ({ agent, dispose: async () => {} }),
      resume: async () => ({ agent, dispose: async () => {} }),
      // Child-agent probe: key is the subagent payload `id`. Undefined → fail closed.
      get: (id: string) => children[id],
    },
  }
  const emitSession = (event: unknown): void => {
    for (const handler of sessionHandlers) handler(agent.session, event)
  }
  const emitStart = (info: unknown): void => {
    for (const handler of startHandlers) handler(info)
  }
  const emitEnd = (info: unknown): void => {
    for (const handler of endHandlers) handler(info)
  }
  return { ctx, emitSession, emitStart, emitEnd }
}

describe('createDriver subagent tracking', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-sub-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('folds subagent/start into a running view and subagent/end into a done view', async () => {
    const agent = makeFakeAgent()
    const { ctx, emitStart, emitEnd } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    emitStart({ runId: 'r1', provider: 'openai', id: 'tui-abcdef01-dead-beef', local: true })
    expect(driver.state.subagents).toHaveLength(1)
    expect(driver.state.subagents[0]).toMatchObject({
      runId: 'r1',
      provider: 'openai',
      sessionId: 'tui-abcdef01-dead-beef',
      status: 'running',
    })
    expect('stopReason' in driver.state.subagents[0]!).toBe(false)

    emitEnd({
      runId: 'r1',
      provider: 'openai',
      id: 'tui-abcdef01-dead-beef',
      local: true,
      stopReason: 'end_turn',
    })
    expect(driver.state.subagents).toHaveLength(1)
    expect(driver.state.subagents[0]!.status).toBe('done')
    expect(driver.state.subagents[0]!.stopReason).toBe('end_turn')
  })

  it('pairs start and end by runId without duplicating', async () => {
    const agent = makeFakeAgent()
    const { ctx, emitStart, emitEnd } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    emitStart({ runId: 'r1', provider: 'openai', id: 'tui-aaaaaaaa', local: true })
    emitStart({ runId: 'r2', provider: 'anthropic', id: 'tui-bbbbbbbb', local: true })
    expect(driver.state.subagents).toHaveLength(2)

    emitEnd({ runId: 'r1', provider: 'openai', id: 'tui-aaaaaaaa', local: true, stopReason: 'stop' })
    expect(driver.state.subagents).toHaveLength(2)
    expect(driver.state.subagents.find(r => r.runId === 'r1')!.status).toBe('done')
    expect(driver.state.subagents.find(r => r.runId === 'r2')!.status).toBe('running')
  })

  it('/agents with no runs shows the empty message', async () => {
    const agent = makeFakeAgent()
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    await driver.submit('/agents')
    const row = driver.state.rows.at(-1)
    expect(row?.kind).toBe('status')
    if (row?.kind === 'status') {
      expect(row.text).toBe('No background agents.')
    }
  })

  it('/agents groups fold runs as Working / Ready with provider decorations', async () => {
    const agent = makeFakeAgent()
    const continuableChild = {
      session: { events: [{ type: 'subagent/descriptor', data: { mode: 'continuable' } }], snapshotEvents() { return this.events } },
    }
    const { ctx, emitStart, emitEnd } = makeCtx(agent, { 'tui-aaaaaaaa': continuableChild })
    const driver = await createDriver(ctx as never, {})

    emitStart({ runId: 'r1', provider: 'openai', id: 'tui-aaaaaaaa', local: true })
    emitStart({ runId: 'r2', provider: 'anthropic', id: 'tui-bbbbbbbb', local: true })
    emitEnd({ runId: 'r1', provider: 'openai', id: 'tui-aaaaaaaa', local: true, stopReason: 'end_turn' })
    await driver.submit('/agents')
    const row = driver.state.rows.at(-1)
    expect(row?.kind).toBe('status')
    if (row?.kind === 'status') {
      expect(row.text).toContain('Background agents:')
      const workingAt = row.text.indexOf('Working (')
      const readyAt = row.text.indexOf('Ready (')
      expect(workingAt).toBeGreaterThan(-1)
      expect(readyAt).toBeGreaterThan(workingAt)
      // The list is label-rendered; the running child appears by short id.
      expect(row.text).toContain('tui-bbbbbbbb')
      // No Done group: done/parked fold runs land in Ready.
      expect(row.text).not.toContain('Done')
      expect(row.text).not.toContain('Blocked')
    }
  })

  it('/agents <id> detail decorates with fold provider and last epoch', async () => {
    const agent = makeFakeAgent()
    const { ctx, emitStart, emitEnd } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    emitStart({ runId: 'r1', provider: 'openai', id: 'tui-abcdef01', local: true })
    emitEnd({ runId: 'r1', provider: 'openai', id: 'tui-abcdef01', local: true, stopReason: 'end_turn' })
    await driver.submit('/agents tui-abcdef01')
    const row = driver.state.rows.at(-1)
    expect(row?.kind).toBe('status')
    if (row?.kind === 'status') {
      expect(row.text).toContain('Agent tui-abcdef01')
      expect(row.text).toContain('residency: ready')
      expect(row.text).toContain('provider: openai')
      expect(row.text).toContain('last epoch: end_turn')
    }
  })

  it('folds continuable subagent/end into parked, not done', async () => {
    const agent = makeFakeAgent()
    const continuableChild = {
      session: { events: [{ type: 'subagent/descriptor', data: { mode: 'continuable' } }], snapshotEvents() { return this.events } },
    }
    const { ctx, emitStart, emitEnd } = makeCtx(agent, { 'tui-abcdef01-dead-beef': continuableChild })
    const driver = await createDriver(ctx as never, {})

    emitStart({ runId: 'r1', provider: 'openai', id: 'tui-abcdef01-dead-beef', local: true })
    emitEnd({
      runId: 'r1',
      provider: 'openai',
      id: 'tui-abcdef01-dead-beef',
      local: true,
      stopReason: 'end_turn',
    })
    expect(driver.state.subagents).toHaveLength(1)
    expect(driver.state.subagents[0]).toMatchObject({
      runId: 'r1',
      sessionId: 'tui-abcdef01-dead-beef',
      status: 'parked',
      resumable: true,
    })
    // stopReason is omitted on parked — the `[completed]` render reads as a crash.
    expect('stopReason' in driver.state.subagents[0]!).toBe(false)
  })

  it('a later start for the same sessionId replaces the parked row', async () => {
    const agent = makeFakeAgent()
    const continuableChild = {
      session: { events: [{ type: 'subagent/descriptor', data: { mode: 'continuable' } }], snapshotEvents() { return this.events } },
    }
    const { ctx, emitStart, emitEnd } = makeCtx(agent, { 'tui-abcdef01-dead-beef': continuableChild })
    const driver = await createDriver(ctx as never, {})

    emitStart({ runId: 'r1', provider: 'openai', id: 'tui-abcdef01-dead-beef', local: true })
    emitEnd({ runId: 'r1', provider: 'openai', id: 'tui-abcdef01-dead-beef', local: true, stopReason: 'end_turn' })
    expect(driver.state.subagents[0]!.status).toBe('parked')

    // Cold-resume: new runId, same sessionId.
    emitStart({ runId: 'r2', provider: 'openai', id: 'tui-abcdef01-dead-beef', local: true })
    expect(driver.state.subagents).toHaveLength(1)
    expect(driver.state.subagents[0]).toMatchObject({
      runId: 'r2',
      sessionId: 'tui-abcdef01-dead-beef',
      status: 'running',
    })
  })

  it('one-shot subagent/end stays done with its stop reason', async () => {
    const agent = makeFakeAgent()
    const { ctx, emitStart, emitEnd } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    emitStart({ runId: 'r1', provider: 'openai', id: 'tui-abcdef01-dead-beef', local: true })
    emitEnd({
      runId: 'r1',
      provider: 'openai',
      id: 'tui-abcdef01-dead-beef',
      local: true,
      stopReason: 'end_turn',
    })
    expect(driver.state.subagents[0]!.status).toBe('done')
    expect(driver.state.subagents[0]!.stopReason).toBe('end_turn')
  })

  it('parked and done fold runs both land in Ready; one-shots keep their epoch decoration', async () => {
    const agent = makeFakeAgent()
    const continuableChild = {
      session: { events: [{ type: 'subagent/descriptor', data: { mode: 'continuable' } }], snapshotEvents() { return this.events } },
    }
    const { ctx, emitStart, emitEnd } = makeCtx(agent, { 'tui-abcdef01-dead-beef': continuableChild })
    const driver = await createDriver(ctx as never, {})

    emitStart({ runId: 'r1', provider: 'openai', id: 'tui-abcdef01-dead-beef', local: true })
    emitEnd({ runId: 'r1', provider: 'openai', id: 'tui-abcdef01-dead-beef', local: true, stopReason: 'end_turn' })
    await driver.submit('/agents')
    const parkedRow = driver.state.rows.at(-1)
    expect(parkedRow?.kind).toBe('status')
    if (parkedRow?.kind === 'status') {
      // Settled continuable is Ready (resumable), not Done.
      expect(parkedRow.text).toContain('Ready (1):')
      expect(parkedRow.text).toContain('tui-abcdef01')
      expect(parkedRow.text).not.toContain('end_turn')
    }

    // One-shot run (no continuable child) also lands in Ready.
    emitStart({ runId: 'r2', provider: 'anthropic', id: 'tui-99999999', local: true })
    emitEnd({ runId: 'r2', provider: 'anthropic', id: 'tui-99999999', local: true, stopReason: 'end_turn' })
    await driver.submit('/agents')
    const doneRow = driver.state.rows.at(-1)
    expect(doneRow?.kind).toBe('status')
    if (doneRow?.kind === 'status') {
      expect(doneRow.text).toContain('Ready (2):')
      expect(doneRow.text).toContain('tui-99999999')
    }
  })

  it('/agents stop on a non-running child explains the no-op and does not interrupt', async () => {
    const agent = makeFakeAgent()
    const continuableChild = {
      session: { events: [{ type: 'subagent/descriptor', data: { mode: 'continuable' } }], snapshotEvents() { return this.events } },
    }
    const interrupt = vi.fn()
    const { ctx, emitStart, emitEnd } = makeCtx(agent, { 'tui-abcdef01-dead-beef': continuableChild })
    const ctxAny = ctx as unknown as { get: (key: string) => unknown }
    const baseGet = ctxAny.get.bind(ctx)
    ctxAny.get = (key: string) => (key === 'subagents' ? { interrupt } : baseGet(key))
    const driver = await createDriver(ctx as never, {})

    emitStart({ runId: 'r1', provider: 'openai', id: 'tui-abcdef01-dead-beef', local: true })
    emitEnd({ runId: 'r1', provider: 'openai', id: 'tui-abcdef01-dead-beef', local: true, stopReason: 'end_turn' })
    await driver.submit('/agents stop tui-abcdef01-dead-beef')
    const row = driver.state.rows.at(-1)
    expect(row?.kind).toBe('status')
    if (row?.kind === 'status') {
      expect(row.text).toContain('not running')
      expect(row.text).toContain('resumable')
    }
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('/agents executes locally while busy (busy-time local-execution regression)', async () => {
    const agent = makeFakeAgent()
    const { ctx, emitStart } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})
    emitStart({ runId: 'r1', provider: 'openai', id: 'tui-aaaaaaaa', local: true })

    // Drive the dialog busy without a turn/end flush (mirrors driver-busy).
    agent.status = 'running'
    driver.state.busy = true
    await driver.submit('/agents')
    const row = driver.state.rows.at(-1)
    expect(row?.kind).toBe('status')
    if (row?.kind === 'status') {
      // Local execution: rendered immediately, not parked in the outbox.
      expect(row.text).toContain('Background agents:')
    }
    expect(driver.state.busy).toBe(true)
    expect(agent.followup).not.toHaveBeenCalled()
    expect(agent.steer).not.toHaveBeenCalled()
  })

  it('/tui-help mentions /agents', async () => {
    const agent = makeFakeAgent()
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    await driver.submit('/tui-help')
    const row = driver.state.rows.at(-1)
    expect(row?.kind).toBe('status')
    if (row?.kind === 'status') {
      expect(row.text).toContain('/agents')
    }
  })

  it('classifies a snapshotEvents()-only child as resumable when its descriptor is continuable (W5 dead-API fix)', async () => {
    const agent = makeFakeAgent()
    const snapshotOnlyChild = {
      session: { snapshotEvents: () => [{ type: 'subagent/descriptor', data: { mode: 'continuable' } }] },
    }
    const { ctx, emitStart } = makeCtx(agent, { 'tui-abcdef01-dead-beef': snapshotOnlyChild })
    const driver = await createDriver(ctx as never, {})

    emitStart({ runId: 'r1', provider: 'openai', id: 'tui-abcdef01-dead-beef', local: true })
    expect(driver.state.subagents[0]).toMatchObject({ sessionId: 'tui-abcdef01-dead-beef', resumable: true })
  })

  it('folds a snapshotEvents()-only continuable child into parked, not done (W5 dead-API probe)', async () => {
    const agent = makeFakeAgent()
    const snapshotOnlyChild = {
      session: { snapshotEvents: () => [{ type: 'subagent/descriptor', data: { mode: 'continuable' } }] },
    }
    const { ctx, emitStart, emitEnd } = makeCtx(agent, { 'tui-abcdef01-dead-beef': snapshotOnlyChild })
    const driver = await createDriver(ctx as never, {})

    emitStart({ runId: 'r1', provider: 'openai', id: 'tui-abcdef01-dead-beef', local: true })
    emitEnd({ runId: 'r1', provider: 'openai', id: 'tui-abcdef01-dead-beef', local: true, stopReason: 'end_turn' })
    expect(driver.state.subagents[0]).toMatchObject({ status: 'parked', resumable: true })
  })

  it('a snapshotEvents()-only child with a one-shot descriptor is NOT resumable', async () => {
    const agent = makeFakeAgent()
    const snapshotOnlyChild = {
      session: { snapshotEvents: () => [{ type: 'subagent/descriptor', data: { mode: 'one-shot' } }] },
    }
    const { ctx, emitStart, emitEnd } = makeCtx(agent, { 'tui-abcdef01-dead-beef': snapshotOnlyChild })
    const driver = await createDriver(ctx as never, {})

    emitStart({ runId: 'r1', provider: 'openai', id: 'tui-abcdef01-dead-beef', local: true })
    emitEnd({ runId: 'r1', provider: 'openai', id: 'tui-abcdef01-dead-beef', local: true, stopReason: 'end_turn' })
    expect(driver.state.subagents[0]).toMatchObject({ status: 'done' })
  })

  it('/agents <id> surfaces the prompt excerpt from a snapshotEvents()-only child (W5 dead-API probe)', async () => {
    const agent = makeFakeAgent()
    const snapshotOnlyChild = {
      session: { snapshotEvents: () => [{ type: 'message', data: { role: 'user', text: 'read the flaky test' } }] },
    }
    const { ctx, emitStart } = makeCtx(agent, { 'tui-abcdef01': snapshotOnlyChild })
    const driver = await createDriver(ctx as never, {})

    emitStart({ runId: 'r1', provider: 'openai', id: 'tui-abcdef01', local: true })
    await driver.submit('/agents tui-abcdef01')
    const row = driver.state.rows.at(-1)
    expect(row?.kind).toBe('status')
    if (row?.kind === 'status') {
      expect(row.text).toContain('prompt: "read the flaky test"')
    }
  })
})

/**
 * /agents release slice (plan T23/T24/T25-tui/T25b-tui): the release branch
 * runs BEFORE any snapshot consultation; only the published ccAgents surface
 * authorizes a release.
 */
describe('createDriver /agents release', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-release-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    resetReleasedMarkers()
  })

  interface ReleaseHarness {
    ctx: ReturnType<typeof makeCtx>['ctx']
    drain: ReturnType<typeof vi.fn>
    interrupt: ReturnType<typeof vi.fn>
    ccAgentsList: ReturnType<typeof vi.fn>
  }

  /** ctx with ccAgents published and a stubbed subagents drain seam. */
  function makeReleaseCtx(agent: FakeAgent, rows: unknown[] = []): ReleaseHarness {
    const built = makeCtx(agent)
    const drain = vi.fn(async () => {})
    const interrupt = vi.fn()
    const ccAgentsList = vi.fn(async () => rows)
    const ctxAny = built.ctx as unknown as { get: (key: string) => unknown }
    const baseGet = ctxAny.get.bind(built.ctx)
    ctxAny.get = (key: string) => {
      if (key === 'ccAgents') return { list: ccAgentsList }
      if (key === 'subagents') return { interrupt, listChildren: async () => [], drainContinuableChildren: drain }
      return baseGet(key)
    }
    return { ctx: built.ctx, drain, interrupt, ccAgentsList }
  }

  it('releases via the drain seam without consulting snapshot rows (T23 catalog-miss + registry-hit)', async () => {
    const agent = makeFakeAgent()
    // Registry hit (resident idle) while the child catalog misses the id —
    // the registry-only release path.
    let resident = true
    const registry = {
      get: (id: string) => (resident && id === 'child-1' ? { status: 'idle' } : undefined),
    }
    const harness = makeReleaseCtx(agent)
    // The drain evicts: the registry entry disappears after the drain call.
    const releaseDrain = vi.fn(async () => { resident = false })
    const ctxAny = harness.ctx as unknown as { get: (key: string) => unknown }
    const baseGet = ctxAny.get.bind(harness.ctx)
    ctxAny.get = (key: string) => {
      if (key === 'subagents') {
        return { interrupt: harness.interrupt, listChildren: async () => [], drainContinuableChildren: releaseDrain }
      }
      return baseGet(key)
    }
    // The registry rides the ctx.agents PROPERTY per F8, not ctx.get('agents').
    ;(harness.ctx as unknown as { agents: unknown }).agents = {
      ...(harness.ctx as unknown as { agents: unknown }).agents,
      get: registry.get,
    }
    const driver = await createDriver(harness.ctx as never, {})

    await driver.submit('/agents release child-1')
    const row = driver.state.rows.at(-1)
    expect(row?.kind).toBe('status')
    if (row?.kind === 'status') {
      expect(row.text).toBe(
        '(Note: child-1 was absent from the readable child catalog — released via the live registry only.) '
        + 'Released agent child-1: its resident (idle) activation was evicted; it held no capacity slot (only running children count toward the 25-child guard). '
        + 'Its resident descendants (if any) were evicted with it. The persisted session survives on disk; within this session it cannot be continued '
        + '(upstream cold-resume-after-drain gap); /agents marks it [released] for the rest of this process.',
      )
    }
    // The drain spy saw the driver's current agent and exactly [id].
    expect(releaseDrain).toHaveBeenCalledTimes(1)
    const [drainParent, drainIds] = releaseDrain.mock.calls[0] as [unknown, unknown[]]
    expect(drainParent).toBe(agent)
    expect(drainIds.map(String)).toEqual(['child-1'])
    // The branch never consulted the snapshot rows.
    expect(harness.ccAgentsList).not.toHaveBeenCalled()
  })

  it('release of a ready row with no registry residency reports not-resident and never drains (T24)', async () => {
    const agent = makeFakeAgent()
    const harness = makeReleaseCtx(agent)
    // Catalog hit (continuable) with no registry residency → not-resident.
    const ctxAny = harness.ctx as unknown as { get: (key: string) => unknown }
    const baseGet = ctxAny.get.bind(harness.ctx)
    ctxAny.get = (key: string) => {
      if (key === 'subagents') {
        return { interrupt: harness.interrupt, listChildren: async () => [{ id: 'child-1', mode: 'continuable' }], drainContinuableChildren: harness.drain }
      }
      return baseGet(key)
    }
    const driver = await createDriver(harness.ctx as never, {})

    await driver.submit('/agents release child-1')
    const row = driver.state.rows.at(-1)
    expect(row?.kind).toBe('status')
    if (row?.kind === 'status') {
      expect(row.text).toBe('Agent child-1 has no resident activation (settled or released); nothing was evicted and no capacity slot is held by it.')
    }
    expect(harness.drain).not.toHaveBeenCalled()
  })

  it('fold-only composition refuses release but keeps fold listing unchanged (T25-tui)', async () => {
    const agent = makeFakeAgent()
    const { ctx, emitStart, emitEnd } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    emitStart({ runId: 'r1', provider: 'openai', id: 'tui-abcdef01', local: true })
    await driver.submit('/agents release tui-abcdef01')
    const row = driver.state.rows.at(-1)
    expect(row?.kind).toBe('status')
    if (row?.kind === 'status') {
      expect(row.text).toBe('Release needs the authoritative agents surface (ccAgents), which this composition does not publish; /agents release is unavailable here.')
    }

    await driver.submit('/agents')
    const listRow = driver.state.rows.at(-1)
    expect(listRow?.kind).toBe('status')
    if (listRow?.kind === 'status') {
      expect(listRow.text).toContain('Background agents:')
    }
  })

  it('stop gates: released Ready row and mid-drain running row both get stopReleasedCopy (T25b-tui)', async () => {
    const parentSessionId = 's-sub'
    const agent = makeFakeAgent()
    const readyRows = [{
      id: 'child-1', residency: 'ready', hasChildren: false, parentId: parentSessionId, released: true,
    }]
    const runningRows = [{
      id: 'child-2', residency: 'running', hasChildren: false, parentId: parentSessionId,
    }]
    const harness = makeReleaseCtx(agent, readyRows)
    const ctxAny = harness.ctx as unknown as { get: (key: string) => unknown }
    const baseGet = ctxAny.get.bind(harness.ctx)
    let rows = readyRows
    ctxAny.get = (key: string) => {
      if (key === 'ccAgents') return { list: async () => rows }
      return baseGet(key)
    }
    const driver = await createDriver(harness.ctx as never, {})

    // A released Ready row gets stopReleasedCopy BEFORE the not-running
    // early-return.
    await driver.submit('/agents stop child-1')
    let row = driver.state.rows.at(-1)
    expect(row?.kind).toBe('status')
    if (row?.kind === 'status') {
      expect(row.text).toBe('Agent child-1 was released (or its release is in flight) in this process; it cannot be continued here — nothing to stop.')
    }
    expect(harness.interrupt).not.toHaveBeenCalled()

    // A RUNNING row whose id isReleasing gets stopReleasedCopy instead of
    // stopRunningCopy — a drain-pending child is not "resumable".
    rows = runningRows
    markReleasing('child-2')
    await driver.submit('/agents stop child-2')
    row = driver.state.rows.at(-1)
    expect(row?.kind).toBe('status')
    if (row?.kind === 'status') {
      expect(row.text).toBe('Agent child-2 was released (or its release is in flight) in this process; it cannot be continued here — nothing to stop.')
    }
    expect(harness.interrupt).not.toHaveBeenCalled()
  })
})
