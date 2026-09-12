import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import { loadHistory, saveHistory } from '@dsh-cc/tui/history.ts'

/**
 * Minimal ctx stub that captures `session/event` and `approval/request`
 * handlers so tests can drive durable events through the live fold. The
 * agent exposes followup/steer/cancel spies so submit/interrupt routing is
 * observable without a real harness.
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

function makeFakeAgent(status: string): FakeAgent {
  return {
    options: {},
    session: { id: 's-busy', header: {}, events: [], snapshotEvents() { return this.events } },
    id: 'a-busy',
    status,
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  }
}

function makeCtx(agent: FakeAgent): { ctx: Record<string, unknown>; emitSession: (event: unknown) => void } {
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
      create: async () => ({ agent, dispose: async () => {} }),
      resume: async () => ({ agent, dispose: async () => {} }),
    },
  }
  const emitSession = (event: unknown): void => {
    for (const handler of sessionHandlers) handler(agent.session, event)
  }
  return { ctx, emitSession }
}

/** Let the microtask-deferred outbox flush (and its dispatch promises) settle. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('createDriver busy input semantics', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-busy-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  /**
   * Extract the joined text blocks from a captured createUserMessage argument
   * so the followup/steer call order is assertable.
   */
  const sentTexts = (calls: readonly unknown[][]): string[] =>
    calls.map(call => {
      const message = call[0] as { content?: readonly { type?: string; text?: string }[] }
      return (message.content ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('')
    })

  it('submit while busy parks the text in the outbox without steering or a user row', async () => {
    const agent = makeFakeAgent('running')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})
    expect(driver.state.busy).toBe(true)

    await driver.submit('steer me')
    // Outbox semantics: a busy submit queues only — nothing is injected into
    // the running turn until turn/end (or an explicit Ctrl+S).
    expect(agent.steer).not.toHaveBeenCalled()
    expect(agent.followup).not.toHaveBeenCalled()
    expect(driver.state.queued).toEqual(['steer me'])
    // No optimistic user row on the queue path.
    expect(driver.state.rows.filter(r => r.kind === 'user')).toHaveLength(0)
  })

  it('submit while idle routes through agent.followup without enqueueing', async () => {
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})
    expect(driver.state.busy).toBe(false)

    await driver.submit('hello')
    expect(agent.followup).toHaveBeenCalledOnce()
    expect(agent.steer).not.toHaveBeenCalled()
    // Idle sends bypass the outbox entirely — nothing to recall once sent.
    expect(driver.state.queued).toEqual([])
    expect(driver.state.busy).toBe(true)
    // No optimistic user row; the row lands on the durable event.
    expect(driver.state.rows.filter(r => r.kind === 'user')).toHaveLength(0)
  })

  it('a durable user/message adds the user row and leaves queued chips untouched', async () => {
    const agent = makeFakeAgent('running')
    const { ctx, emitSession } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    await driver.submit('hello')
    expect(driver.state.queued).toEqual(['hello'])

    emitSession({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } })
    // The fold only renders the row; chip clearing is driver-side and
    // synchronous (flush / Ctrl+S / interrupt / recall), never event-driven.
    expect(driver.state.queued).toEqual(['hello'])
    expect(driver.state.rows).toContainEqual({ kind: 'user', text: 'hello' })
  })

  it('turn/end flushes the outbox FIFO through followup and optimistically sets busy', async () => {
    const agent = makeFakeAgent('running')
    const { ctx, emitSession } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    await driver.submit('one')
    await driver.submit('two')
    expect(driver.state.queued).toEqual(['one', 'two'])

    emitSession({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await settle()
    expect(sentTexts(agent.followup.mock.calls)).toEqual(['one', 'two'])
    expect(agent.steer).not.toHaveBeenCalled()
    // Dispatched and cleared in one atomic stroke (deferred one microtask out
    // of the session append publication window).
    expect(driver.state.queued).toEqual([])
    // Optimistic busy: the flushed followups start a new turn immediately.
    expect(driver.state.busy).toBe(true)
  })

  it('turn/end flush waits for agent convergence when whenIdle is available', async () => {
    const agent = makeFakeAgent('running')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    agent.whenIdle = () => gate
    const { ctx, emitSession } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    await driver.submit('queued line')
    emitSession({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await settle()
    // The driver-teardown gap must pass first: nothing dispatches, nothing clears.
    expect(agent.followup).not.toHaveBeenCalled()
    expect(driver.state.queued).toEqual(['queued line'])

    release()
    await settle()
    expect(sentTexts(agent.followup.mock.calls)).toEqual(['queued line'])
    expect(driver.state.queued).toEqual([])
    expect(driver.state.busy).toBe(true)
  })

  it('an errored turn/end still flushes the outbox', async () => {    const agent = makeFakeAgent('running')
    const { ctx, emitSession } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    await driver.submit('retry me')
    emitSession({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'boom' } } },
    })
    await settle()
    expect(sentTexts(agent.followup.mock.calls)).toEqual(['retry me'])
    expect(driver.state.queued).toEqual([])
    expect(driver.state.busy).toBe(true)
  })

  it('steerQueued injects every queued entry through agent.steer and clears the queue', async () => {
    const agent = makeFakeAgent('running')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    await driver.submit('one')
    await driver.submit('two')
    driver.steerQueued()
    // Queue-jump: steer, not followup, and cleared synchronously.
    expect(sentTexts(agent.steer.mock.calls)).toEqual(['one', 'two'])
    expect(agent.followup).not.toHaveBeenCalled()
    expect(driver.state.queued).toEqual([])
  })

  it('a turn/end after interrupt finds an empty queue and does not flush', async () => {
    const agent = makeFakeAgent('running')
    const { ctx, emitSession } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    await driver.submit('doomed entry')
    driver.interrupt()
    expect(driver.state.queued).toEqual([])

    emitSession({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    await settle()
    expect(agent.followup).not.toHaveBeenCalled()
    expect(driver.state.queued).toEqual([])
  })

  it('recallQueued pops the most recent queued entry for editing', async () => {
    const agent = makeFakeAgent('running')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    await driver.submit('one')
    await driver.submit('two')
    expect(driver.recallQueued()).toBe('two')
    expect(driver.state.queued).toEqual(['one'])
  })

  it('recallQueued on an empty queue returns undefined and leaves the state alone', async () => {
    const agent = makeFakeAgent('running')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    expect(driver.recallQueued()).toBeUndefined()
    expect(driver.state.queued).toEqual([])
  })

  it('interrupt calls agent.cancel({kind:"user"}), clears queued, sets busy false, and notes the interruption', async () => {
    const agent = makeFakeAgent('running')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})
    await driver.submit('pending steer')
    expect(driver.state.queued).toEqual(['pending steer'])
    expect(driver.state.busy).toBe(true)

    driver.interrupt()
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(driver.state.queued).toEqual([])
    expect(driver.state.busy).toBe(false)
    // The boot banner is also a status row; pin the interruption row specifically.
    const interrupted = driver.state.rows.filter(r => r.kind === 'status' && r.text.includes('Interrupted'))
    expect(interrupted).toHaveLength(1)
  })

  it('compaction/start anchors a working line on an idle agent (manual compact is busy)', async () => {
    const agent = makeFakeAgent('idle')
    const { ctx, emitSession } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})
    expect(driver.state.busy).toBe(false)

    emitSession({ type: 'compaction/start', data: { compactionId: 'c1', turn: null } })
    expect(driver.state.busy).toBe(true)
    expect(driver.state.turn).toBeDefined()
  })

  it('compaction/start during a live turn keeps the existing anchor (auto-compact)', async () => {
    const agent = makeFakeAgent('running')
    const { ctx, emitSession } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})
    expect(driver.state.busy).toBe(true)
    const startedAt = driver.state.turn?.startedAt
    expect(startedAt).toBeDefined()
    await new Promise(resolve => setTimeout(resolve, 5))

    emitSession({ type: 'compaction/start', data: { compactionId: 'c1', turn: null } })
    expect(driver.state.busy).toBe(true)
    expect(driver.state.turn?.startedAt).toBe(startedAt)
    // The turn belongs to the live request — compaction/end must not clear it.
    emitSession({ type: 'compaction/end', data: { compactionId: 'c1', turn: null } })
    expect(driver.state.turn?.startedAt).toBe(startedAt)
    expect(driver.state.busy).toBe(true)
  })

  it('idle manual compact: submit queues while busy; compaction/end flushes via followup', async () => {
    const agent = makeFakeAgent('idle')
    const { ctx, emitSession } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    emitSession({ type: 'compaction/start', data: { compactionId: 'c1', turn: null } })
    expect(driver.state.busy).toBe(true)
    await driver.submit('queued during compact')
    expect(driver.state.queued).toEqual(['queued during compact'])
    expect(agent.followup).not.toHaveBeenCalled()

    emitSession({ type: 'compaction/end', data: { compactionId: 'c1', turn: null } })
    await settle()
    expect(sentTexts(agent.followup.mock.calls)).toEqual(['queued during compact'])
    expect(driver.state.queued).toEqual([])
  })

  it('an unknown slash falls through as a user prompt (skill-load path)', async () => {
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent)
    const baseGet = ctx.get.bind(ctx) as (key: string) => unknown
    ctx.get = (key: string) => key === 'commands'
      ? { execute: async () => undefined }
      : baseGet(key)
    const driver = await createDriver(ctx as never, {})

    await driver.submit('/not-a-real-command')
    // Registry miss is not an error notice: user-invocable skills load by
    // sending the typed `/name` as an ordinary user message.
    expect(driver.state.notice).toBeUndefined()
    expect(sentTexts(agent.followup.mock.calls)).toEqual(['/not-a-real-command'])
  })

  it('a successful compact result with a painted compact row does not echo a status row', async () => {
    const agent = makeFakeAgent('idle')
    const { ctx, emitSession } = makeCtx(agent)
    const baseGet = ctx.get.bind(ctx) as (key: string) => unknown
    ctx.get = (key: string) => key === 'commands'
      ? {
          execute: async () => ({
            result: { kind: 'success', text: 'Compacted 3 history items (~10 tokens).', sourceEventSeq: 99 },
          }),
        }
      : baseGet(key)
    const driver = await createDriver(ctx as never, {})

    emitSession({ type: 'compaction/summary', seq: 9, data: { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 10, sourceCommandId: 'cmd-1' } })
    emitSession({ type: 'user/message', seq: 10, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 }, data: { content: [{ type: 'text', text: '<compacted-summary>body</compacted-summary>' }], source: { kind: 'plugin', plugin: 'compact', sourceCommandId: 'cmd-1' } } })
    expect(driver.state.rows.some(r => r.kind === 'compact')).toBe(true)

    await driver.submit('/compact')
    const echoes = driver.state.rows.filter(r => r.kind === 'status' && r.text.includes('Compacted 3 history items'))
    expect(echoes).toHaveLength(0)
  })

  it('a failed compact result still echoes as an error status row', async () => {
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent)
    const baseGet = ctx.get.bind(ctx) as (key: string) => unknown
    ctx.get = (key: string) => key === 'commands'
      ? { execute: async () => ({ result: { kind: 'error', text: 'No compactable history yet.' } }) }
      : baseGet(key)
    const driver = await createDriver(ctx as never, {})

    await driver.submit('/compact')
    const rows = driver.state.rows.filter(r => r.kind === 'status' && r.text === 'No compactable history yet.')
    expect(rows).toHaveLength(1)
    expect((rows[0] as { error?: boolean }).error).toBe(true)
  })
})

describe('createDriver composer history persistence', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-hist-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('persists a submitted prompt and surfaces it via promptHistory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-histdrv-'))
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, { historyDir: dir })
    expect(driver.promptHistory).toEqual([])

    await driver.submit('hello world')
    expect(driver.promptHistory).toEqual(['hello world'])
    // Persisted to disk — a fresh load reads it back.
    expect(loadHistory(dir)).toEqual(['hello world'])
  })

  it('does not persist slash commands (local or harness)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-histdrv-'))
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, { historyDir: dir })

    await driver.submit('/quit')
    expect(driver.promptHistory).toEqual([])
    expect(loadHistory(dir)).toEqual([])
  })

  it('suppresses a consecutive-duplicate prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-histdrv-'))
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, { historyDir: dir })

    await driver.submit('same')
    await driver.submit('same')
    expect(driver.promptHistory).toEqual(['same'])
    expect(loadHistory(dir)).toEqual(['same'])
  })

  it('reflects the boot-loaded history file in promptHistory (oldest→newest)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-histdrv-'))
    saveHistory(['old prompt', 'newer prompt'], dir)
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, { historyDir: dir })
    expect(driver.promptHistory).toEqual(['old prompt', 'newer prompt'])
  })
})
