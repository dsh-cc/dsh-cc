import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCatalogSection } from '@dsh-cc/tui/harness/driver-catalog.ts'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import { parseSlash, setPluginSlashNames } from '@dsh-cc/tui/slash.ts'

/**
 * Plugin-command wiring: the cc-shell `ccPlugins` service (duck-typed, colon
 * form `plugin:command`) feeds (1) parseSlash classification, (2) the merged
 * command catalog + its `ccPlugins/change` refresh, and (3) runLocal
 * dispatch with a live agent reference and prompt-matching busy semantics.
 * A missing service must degrade: no catalog entries, unknown colon names
 * keep the harness/prompt fall-through.
 */

// --- fake ccPlugins service (hand-written against the pinned contract) ------

interface PluginCall {
  name: string
  agent: unknown
  rawInput: string
}

function makePluginService(
  commands: readonly { name: string; plugin: string; description: string; argumentHint?: string }[],
  run?: (call: PluginCall) => { ok: true } | { ok: false; reason: string },
): {
  service: {
    listPluginCommands: () => readonly typeof commands[number][]
    runPluginCommand: (name: string, input: PluginCall) => Promise<{ ok: true } | { ok: false; reason: string }>
  }
  calls: PluginCall[]
} {
  const calls: PluginCall[] = []
  const service = {
    listPluginCommands: () => commands,
    runPluginCommand: async (name: string, input: PluginCall) => {
      calls.push({ name, agent: input.agent, rawInput: input.rawInput })
      return run?.(input) ?? { ok: true as const }
    },
  }
  return { service, calls }
}

// --- parseSlash classification ---------------------------------------------

describe('parseSlash plugin-command classification', () => {
  afterEach(() => setPluginSlashNames([]))

  it('classifies a known colon name as local with the tail as rawInput', () => {
    setPluginSlashNames(['codex:review'])
    expect(parseSlash('/codex:review extra args')).toEqual({ kind: 'local', name: 'codex:review', rawInput: 'extra args' })
    expect(parseSlash('/codex:review')).toEqual({ kind: 'local', name: 'codex:review', rawInput: '' })
  })

  it('matches case-insensitively (lowercase convention)', () => {
    setPluginSlashNames(['codex:review'])
    expect(parseSlash('/CODEX:REVIEW args')).toEqual({ kind: 'local', name: 'codex:review', rawInput: 'args' })
  })

  it('an UNKNOWN colon name keeps the harness fall-through', () => {
    setPluginSlashNames(['codex:review'])
    expect(parseSlash('/foo:bar')).toEqual({ kind: 'harness', line: '/foo:bar' })
    expect(parseSlash('/foo:bar args')).toEqual({ kind: 'harness', line: '/foo:bar args' })
  })

  it('with an empty plugin table colon names stay harness (degradation)', () => {
    setPluginSlashNames([])
    expect(parseSlash('/codex:review')).toEqual({ kind: 'harness', line: '/codex:review' })
  })

  it('built-in local names still win over a plugin claim', () => {
    setPluginSlashNames(['quit'])
    expect(parseSlash('/quit')).toEqual({ kind: 'local', name: 'quit', rawInput: '' })
  })
})

// --- catalog merge -----------------------------------------------------------

const baseState = (): Record<string, unknown> => ({ rows: [], subagents: [], queued: [], busy: false, draft: '' })

function makeCatalogRt(opts: { plugin?: unknown }) {
  let state = baseState()
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'ccPlugins') return opts.plugin
      return undefined
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
  }
  const emit = vi.fn((next: unknown) => {
    state = next as Record<string, unknown>
  })
  const rt = {
    emit: emit as unknown as (next: never) => void,
    state: () => state,
    current: { agent: { session: { header: {} } } },
    ctx: ctx as never,
  }
  const fireChange = (): void => handlers.get('ccPlugins/change')?.()
  return { rt, emit, fireChange, hasChangeHandler: () => handlers.has('ccPlugins/change') }
}

describe('createCatalogSection plugin merge', () => {
  it('merges colon-form plugin entries with description and argumentHint', () => {
    const { service } = makePluginService([
      { name: 'codex:review', plugin: 'codex', description: 'Review the diff', argumentHint: '<pr>' },
    ])
    const { rt } = makeCatalogRt({ plugin: service })
    const section = createCatalogSection(rt as never)
    const entries = section.listCommands().filter(c => c.name.includes(':'))
    expect(entries).toEqual([{ name: 'codex:review', description: 'Review the diff', argumentHint: '<pr>' }])
  })

  it('LOCAL_COMMANDS and harness names win over a same-named plugin entry', () => {
    const { service } = makePluginService([
      { name: 'quit', plugin: 'evil', description: 'evil quit' },
      { name: 'status', plugin: 'evil', description: 'evil status' },
      { name: 'codex:review', plugin: 'codex', description: 'ok' },
    ])
    const { rt } = makeCatalogRt({ plugin: service })
    const section = createCatalogSection(rt as never)
    const names = section.listCommands().map(c => c.name)
    expect(names.filter(n => n === 'quit')).toHaveLength(1)
    expect(names.filter(n => n === 'status')).toHaveLength(1)
    expect(names).toContain('codex:review')
  })

  it('subscribes to ccPlugins/change and refreshes the catalog on it', () => {
    const { service } = makePluginService([
      { name: 'codex:review', plugin: 'codex', description: 'v1' },
    ])
    const { rt, emit, fireChange } = makeCatalogRt({ plugin: service })
    const section = createCatalogSection(rt as never)
    const emitsAfterBoot = emit.mock.calls.length
    fireChange()
    expect(emit.mock.calls.length).toBeGreaterThan(emitsAfterBoot)
    expect(section.listCommands().map(c => c.name)).toContain('codex:review')
  })

  it('a missing ccPlugins service contributes no entries but still subscribes to ccPlugins/change', () => {
    // The subscription is unconditional: the cc-shell bundle may publish the
    // service AFTER the driver mounted, and the shared cordis event bus
    // delivers the change even without the service present yet.
    const { rt, hasChangeHandler, fireChange } = makeCatalogRt({})
    const section = createCatalogSection(rt as never)
    expect(section.listCommands().some(c => c.name.includes(':'))).toBe(false)
    expect(hasChangeHandler()).toBe(true)
    const service = makePluginService([
      { name: 'codex:review', plugin: 'codex', description: 'late arrival' },
    ]).service
    ;(rt as unknown as { ctx: { get: (key: string) => unknown } }).ctx.get = (key: string) =>
      key === 'ccPlugins' ? service : undefined
    fireChange()
    expect(section.listCommands().map(c => c.name)).toContain('codex:review')
    // Regression guard for the real-machine e2e leak: a colon name published
    // only after boot must classify as local (not harness) so the queue's
    // flush re-routes it through runPluginCommand instead of raw-sending.
    expect(parseSlash('/codex:review args')).toEqual({ kind: 'local', name: 'codex:review', rawInput: 'args' })
  })

  it('a throwing listPluginCommands degrades to local-only without poisoning', () => {
    const bad = { listPluginCommands: () => { throw new Error('boom') } }
    const { rt } = makeCatalogRt({ plugin: bad })
    const section = createCatalogSection(rt as never)
    expect(section.listCommands().length).toBeGreaterThan(0)
  })
})

// --- runLocal dispatch (through createDriver submit) -------------------------

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
    session: { id: 's-plugin', header: {}, events: [] },
    id: 'a-plugin',
    status,
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  }
}

function makeCtx(agent: FakeAgent, plugin: unknown | (() => unknown)): { ctx: Record<string, unknown>; fireSessionEvent: (event: { type: string }) => void } {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return { defaultId: 'cc', resolve: async () => ({ id: 'cc' }), mount: async () => ({ id: 'cc' }) }
      }
      if (key === 'ccPlugins') return typeof plugin === 'function' ? plugin() : plugin
      return undefined
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    agents: {
      create: async () => ({ agent, dispose: async () => {} }),
      resume: async () => ({ agent, dispose: async () => {} }),
    },
  }
  // Fires the durable session-event fold (driver-agent.attachSessionEvents);
  // used to drive the outbox flush exactly as the turn/end anchor does.
  const fireSessionEvent = (event: { type: string }): void => {
    handlers.get('session/event')?.({ id: agent.session.id }, event)
  }
  return { ctx, fireSessionEvent }
}

describe('runLocal plugin dispatch', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-plugin-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    setPluginSlashNames([])
  })

  it('idle submit dispatches runPluginCommand with the live agent and rawInput, then sets the turn tail', async () => {
    const agent = makeFakeAgent('idle')
    const { service, calls } = makePluginService(
      [{ name: 'codex:review', plugin: 'codex', description: 'review' }],
    )
    const { ctx } = makeCtx(agent, service)
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/codex:review fix the bug')
    expect(calls).toEqual([{ name: 'codex:review', agent, rawInput: 'fix the bug' }])
    expect(calls[0]!.agent).toBe(agent) // live reference, not a cached boot copy
    // Turn tail mirrors the prompt path.
    expect(driver.state.busy).toBe(true)
    expect(driver.state.queued).toEqual([])
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('an {ok:false} result surfaces a user-visible notice', async () => {
    const agent = makeFakeAgent('idle')
    const { service, calls } = makePluginService(
      [{ name: 'codex:review', plugin: 'codex', description: 'review' }],
      () => ({ ok: false, reason: 'no git repo' }),
    )
    const { ctx } = makeCtx(agent, service)
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/codex:review')
    expect(calls).toHaveLength(1)
    expect(driver.state.notice).toBeDefined()
    expect(String(driver.state.notice?.text ?? driver.state.notice)).toContain('no git repo')
  })

  it('while busy the line parks in the outbox instead of dispatching', async () => {
    const agent = makeFakeAgent('running')
    const { service, calls } = makePluginService(
      [{ name: 'codex:review', plugin: 'codex', description: 'review' }],
    )
    const { ctx } = makeCtx(agent, service)
    const driver = await createDriver(ctx as never, {})
    expect(driver.state.busy).toBe(true)
    await driver.submit('/codex:review later args')
    expect(calls).toHaveLength(0)
    expect(driver.state.queued).toEqual(['/codex:review later args'])
    expect(agent.followup).not.toHaveBeenCalled()
    expect(agent.steer).not.toHaveBeenCalled()
  })

  it('a missing ccPlugins service keeps unknown colon names on the prompt fall-through', async () => {
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent, undefined)
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/foo:bar explain this')
    // No notice, no followup: the harness registry is absent, so runHarness
    // null-stops and the line does NOT become a model prompt — it is refused
    // the same way a harness command with no registry is.
    expect(driver.state.notice).toBeDefined()
    expect(agent.followup).not.toHaveBeenCalled()
  })
})

// --- outbox flush / steer re-classification ----------------------------------

/** Let the fire-and-forget `.then` chain in dispatchQueued settle. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('outbox flush and steer of queued plugin commands', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-plugin-'))
    process.env.DSH_HOME = tempHome
    setPluginSlashNames(['codex:review'])
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    setPluginSlashNames([])
  })

  it('turn/end flush re-routes a queued plugin command through runPluginCommand, not the raw text', async () => {
    const { service, calls } = makePluginService(
      [{ name: 'codex:review', plugin: 'codex', description: 'review' }],
    )
    const agent = makeFakeAgent('running')
    const { ctx, fireSessionEvent } = makeCtx(agent, service)
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/codex:review later args')
    expect(driver.state.queued).toEqual(['/codex:review later args'])
    fireSessionEvent({ type: 'turn/end' })
    await settle()
    expect(calls).toEqual([{ name: 'codex:review', agent, rawInput: 'later args' }])
    expect(agent.followup).not.toHaveBeenCalled()
    expect(driver.state.queued).toEqual([])
  })

  it('turn/end flush dispatches a mixed queue FIFO: plugin command then plain text', async () => {
    const { service, calls } = makePluginService(
      [{ name: 'codex:review', plugin: 'codex', description: 'review' }],
    )
    const agent = makeFakeAgent('running')
    const { ctx, fireSessionEvent } = makeCtx(agent, service)
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/codex:review later args')
    await driver.submit('plain queued text')
    expect(driver.state.queued).toEqual(['/codex:review later args', 'plain queued text'])
    fireSessionEvent({ type: 'turn/end' })
    await settle()
    await settle()
    // The plugin entry routes through the seam; the plain entry follows as a
    // raw followup — neither is dropped or reordered.
    expect(calls).toEqual([{ name: 'codex:review', agent, rawInput: 'later args' }])
    expect(agent.followup).toHaveBeenCalledTimes(1)
    const sent = agent.followup.mock.calls[0]?.[0] as { content: { type: string; text: string }[] }
    expect(sent.content[0]?.text).toBe('plain queued text')
    expect(driver.state.queued).toEqual([])
  })

  it('Ctrl+S steer re-routes a queued plugin command through runPluginCommand', async () => {
    const { service, calls } = makePluginService(
      [{ name: 'codex:review', plugin: 'codex', description: 'review' }],
    )
    const agent = makeFakeAgent('running')
    const { ctx } = makeCtx(agent, service)
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/codex:review now args')
    driver.steerQueued()
    expect(calls).toEqual([{ name: 'codex:review', agent, rawInput: 'now args' }])
    expect(agent.steer).not.toHaveBeenCalled()
    expect(agent.followup).not.toHaveBeenCalled()
    expect(driver.state.queued).toEqual([])
  })

  it('an {ok:false} result on flush surfaces a notice and never raw-sends the slash line', async () => {
    const { service, calls } = makePluginService(
      [{ name: 'codex:review', plugin: 'codex', description: 'review' }],
      () => ({ ok: false, reason: 'no git repo' }),
    )
    const agent = makeFakeAgent('running')
    const { ctx, fireSessionEvent } = makeCtx(agent, service)
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/codex:review later args')
    fireSessionEvent({ type: 'turn/end' })
    await settle()
    expect(calls).toHaveLength(1)
    expect(agent.followup).not.toHaveBeenCalled()
    expect(driver.state.notice).toBeDefined()
    const notice = String(driver.state.notice)
    expect(notice).toContain('codex:review')
    expect(notice).toContain('no git repo')
    // An all-dropped flush must not anchor a zombie busy turn.
    expect(driver.state.busy).toBe(false)
    expect('turn' in driver.state).toBe(false)
  })

  it('a rejected runPluginCommand on flush surfaces a notice and never raw-sends', async () => {
    const service = {
      listPluginCommands: () => [{ name: 'codex:review', plugin: 'codex', description: 'review' }],
      runPluginCommand: async () => { throw new Error('boom at flush') },
    }
    const agent = makeFakeAgent('running')
    const { ctx, fireSessionEvent } = makeCtx(agent, service)
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/codex:review later args')
    fireSessionEvent({ type: 'turn/end' })
    await settle()
    expect(agent.followup).not.toHaveBeenCalled()
    expect(driver.state.notice).toBeDefined()
    const notice = String(driver.state.notice)
    expect(notice).toContain('codex:review')
    expect(notice).toContain('boom at flush')
  })

  it('a name that left the plugin table before flush degrades to the raw line', async () => {
    // Same failure surface, but the command was uninstalled between enqueue
    // and flush (the service is still mounted, the name is gone from
    // listPluginCommands): the raw-line fall-through (unknown-slash
    // philosophy) applies.
    const table: { name: string }[] = [{ name: 'codex:review' }]
    const service = {
      listPluginCommands: () => table,
      runPluginCommand: async () => ({ ok: false as const, reason: 'uninstalled' }),
    }
    const agent = makeFakeAgent('running')
    const { ctx, fireSessionEvent } = makeCtx(agent, service)
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/codex:review later args')
    expect(driver.state.queued).toEqual(['/codex:review later args'])
    table.length = 0
    fireSessionEvent({ type: 'turn/end' })
    await settle()
    expect(agent.followup).toHaveBeenCalledTimes(1)
    const message = agent.followup.mock.calls[0]![0] as { content: { type: string; text?: string }[] }
    expect(message.content[0]?.text).toBe('/codex:review later args')
  })

  it('a missing ccPlugins service degrades to the original raw followup on flush', async () => {
    // The service must be present at submit (so the busy line parks in the
    // outbox and the catalog publishes the name), then vanish before flush.
    let plugin: unknown = makePluginService(
      [{ name: 'codex:review', plugin: 'codex', description: 'review' }],
    ).service
    const agent = makeFakeAgent('running')
    const { ctx, fireSessionEvent } = makeCtx(agent, () => plugin)
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/codex:review later args')
    expect(driver.state.queued).toEqual(['/codex:review later args'])
    plugin = undefined
    fireSessionEvent({ type: 'turn/end' })
    await settle()
    expect(agent.followup).toHaveBeenCalledTimes(1)
    const message = agent.followup.mock.calls[0]![0] as { content: { type: string; text?: string }[] }
    expect(message.content[0]?.text).toBe('/codex:review later args')
  })

  it('runLocal shows a notice instead of rejecting when runPluginCommand throws', async () => {
    const agent = makeFakeAgent('idle')
    const throwing = {
      listPluginCommands: () => [{ name: 'codex:review', plugin: 'codex', description: 'review' }],
      runPluginCommand: async () => { throw new Error('boom') },
    }
    const { ctx } = makeCtx(agent, throwing)
    const driver = await createDriver(ctx as never, {})
    await expect(driver.submit('/codex:review')).resolves.toBeUndefined()
    expect(driver.state.notice).toBeDefined()
    expect(String(driver.state.notice?.text ?? driver.state.notice)).toContain('boom')
    expect(agent.followup).not.toHaveBeenCalled()
  })
})
