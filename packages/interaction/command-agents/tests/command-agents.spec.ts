import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as commandAgents from '@dsh-cc/command-agents'
import {
  isReleased,
  isReleasing,
  markReleased,
  resetReleasedMarkers,
} from '@dsh-cc/command-agents/release'
import {
  buildAgentsSnapshot,
  denyCodeOf,
  parseAgentsInput,
  renderAgentDetail,
  renderAgentsList,
  type AgentRow,
  type SnapshotServices,
} from '@dsh-cc/command-agents/snapshot'

// --- fakes ------------------------------------------------------------------

/** rc.2 catalog row shape (`SubagentCatalogEntry`): no `activity`/`hasChildren`. */
interface FakeChild {
  id: string
  mode?: 'one-shot' | 'continuable'
  label?: string
}

function makeServices(
  children: readonly FakeChild[],
  agents: Record<string, { status?: string }> = {},
  /** Child ids that carry durable sub-descendants (rc.2 `listDescendants` fold). */
  descendantParents: Map<string, boolean> = new Map(),
): SnapshotServices & {
  interrupts: { id: string; authority: unknown }[]
} {
  const interrupts: { id: string; authority: unknown }[] = []
  return {
    listChildren: async () => children,
    // rc.2 re-derivation: the `[has children]` tag comes from descendant rows.
    listDescendants: async () => [...descendantParents.entries()]
      .filter(([, has]) => has)
      .map(([id]) => ({ id, hasChildren: true })),
    getAgent: (id: string) => agents[id],
    readPin: (childId: string) => {
      if (childId === 'pinned-ok') {
        return { childId, label: 'slow work', mode: 'continuable-background', definition: { agentType: 'deep-reasoner', source: 'bundled' }, modelSelector: { raw: 'deepseek/deepseek-r1', via: 'alias' }, workspace: { cwd: '/w', branch: 'main' }, resume: { state: 'ok' } }
      }
      if (childId === 'pinned-deny') {
        return { childId, label: 'fast work', mode: 'continuable-background', definition: { agentType: 'fast-worker', source: 'project' }, modelSelector: { raw: 'inherit', via: 'inherit' }, workspace: { cwd: '/w2', branch: 'dev' }, resume: { state: 'blocked', reason: '[WORKSPACE_CHANGED] workspace repository identity changed since spawn' } }
      }
      if (childId === 'pinned-corrupt') return { kind: 'corrupt', reason: 'unreadable: EACCES' }
      return undefined
    },
    pinPath: (childId: string) => `/sessions/resume-pins/${childId}.json`,
    interrupt: (id: string, authority: unknown) => { interrupts.push({ id, authority }) },
    interrupts,
  }
}

const PARENT = 'parent-1'

async function rows(services: ReturnType<typeof makeServices>): Promise<AgentRow[]> {
  return buildAgentsSnapshot(services, PARENT)
}

// --- pure snapshot + rendering ----------------------------------------------

describe('buildAgentsSnapshot', () => {
  it('derives residency: running child with live running agent', async () => {
    const services = makeServices(
      [{ id: 'c1', mode: 'continuable', label: 'scout' }],
      { c1: { status: 'running' } },
    )
    expect(await rows(services)).toEqual([
      { id: 'c1', label: 'scout', residency: 'running', hasChildren: false, parentId: PARENT, pin: undefined },
    ])
  })

  it('derives idle: live agent present but not running', async () => {
    const services = makeServices(
      [{ id: 'c2', mode: 'continuable', label: 'worker' }],
      { c2: { status: 'idle' } },
    )
    expect((await rows(services))[0]!.residency).toBe('idle')
  })

  it('derives ready: settled continuable child with no live agent', async () => {
    const services = makeServices([{ id: 'c3', mode: 'continuable', label: 'done-child' }])
    expect((await rows(services))[0]!.residency).toBe('ready')
  })

  it('derives ready: persistence-only child (no live activation)', async () => {
    const services = makeServices([{ id: 'c4', mode: 'continuable', label: 'parked' }])
    expect((await rows(services))[0]!.residency).toBe('ready')
  })

  it('attaches pin state including gate deny code', async () => {
    const services = makeServices([
      { id: 'pinned-ok', mode: 'continuable', label: 'a' },
      { id: 'pinned-deny', mode: 'continuable', label: 'b' },
      { id: 'pinned-corrupt', mode: 'continuable', label: 'c' },
      { id: 'unpinned', mode: 'continuable', label: 'd' },
    ])
    const list = await rows(services)
    expect(list.find(r => r.id === 'pinned-ok')!.pin).toEqual({ state: 'pinned' })
    expect(list.find(r => r.id === 'pinned-deny')!.pin).toEqual({ state: 'blocked', denyCode: 'WORKSPACE_CHANGED' })
    expect(list.find(r => r.id === 'pinned-corrupt')!.pin).toEqual({ state: 'corrupt' })
    expect(list.find(r => r.id === 'unpinned')!.pin).toBeUndefined()
  })
})

describe('renderAgentsList', () => {
  it('renders an empty state', () => {
    expect(renderAgentsList([])).toBe('No background agents.')
  })

  it('groups Working / Idle / Ready in that order with pinned rows', async () => {
    const services = makeServices([
      { id: 'ready-1', mode: 'continuable', label: 'zzz' },
      { id: 'run-1', mode: 'continuable', label: 'aaa' },
      { id: 'idle-1', mode: 'continuable', label: 'bbb' },
      { id: 'pinned-deny', mode: 'continuable', label: 'mmm' },
    ], { 'run-1': { status: 'running' }, 'idle-1': { status: 'idle' } })
    const text = renderAgentsList(await rows(services))
    const workingAt = text.indexOf('Working (')
    const idleAt = text.indexOf('Idle (')
    const readyAt = text.indexOf('Ready (')
    expect(workingAt).toBeGreaterThan(-1)
    expect(idleAt).toBeGreaterThan(workingAt)
    expect(readyAt).toBeGreaterThan(idleAt)
    expect(text).toContain('aaa')
    expect(text).toContain('bbb')
    expect(text).toContain('zzz')
    expect(text).toContain('[gate: WORKSPACE_CHANGED]')
    expect(text).not.toContain('Blocked')
    expect(text).not.toContain('Done')
  })

  it('sorts deterministically within a group', async () => {
    const services = makeServices([
      { id: 'b', mode: 'continuable', label: 'same' },
      { id: 'a', mode: 'continuable', label: 'same' },
    ], { a: { status: 'running' }, b: { status: 'running' } })
    const text = renderAgentsList(await rows(services))
    expect(text.indexOf('a')).toBeLessThan(text.indexOf('b', text.indexOf('a') + 1))
  })
})

describe('renderAgentDetail', () => {
  it('renders ids, residency, children, and pin provenance', async () => {
    const services = makeServices(
      [{ id: 'pinned-ok', mode: 'continuable', label: 'scout' }],
      {},
      new Map([['pinned-ok', true]]),
    )
    const list = await rows(services)
    const text = renderAgentDetail(list[0]!, services.readPin('pinned-ok'), services.pinPath('pinned-ok'), PARENT)
    expect(text).toContain('pinned-ok')
    expect(text).toContain('residency: ready')
    expect(text).toContain('children: present')
    expect(text).toContain('/sessions/resume-pins/pinned-ok.json')
    expect(text).toContain('deep-reasoner')
    expect(text).toContain('deepseek/deepseek-r1')
    expect(text).toContain(`parent session: ${PARENT}`)
  })
})

describe('parseAgentsInput', () => {
  it('parses list / detail / stop forms', () => {
    expect(parseAgentsInput('')).toEqual({ kind: 'list' })
    expect(parseAgentsInput('  ')).toEqual({ kind: 'list' })
    expect(parseAgentsInput('abc-123')).toEqual({ kind: 'detail', id: 'abc-123' })
    expect(parseAgentsInput('stop abc-123')).toEqual({ kind: 'stop', id: 'abc-123' })
  })
  it('rejects bare stop and reserved attach with copy', () => {
    expect(parseAgentsInput('stop')).toMatchObject({ kind: 'error' })
    expect(parseAgentsInput('stop')).toEqual({ kind: 'error', text: 'Usage: /agents stop <id>' })
    expect(parseAgentsInput('attach x')).toMatchObject({ kind: 'error' })
    expect(parseAgentsInput('attach x').kind === 'error' && parseAgentsInput('attach x').text).toContain('not implemented')
  })
  it('T19: parses the release form; bare release gets usage copy; legacy forms unchanged', () => {
    expect(parseAgentsInput('release abc-123')).toEqual({ kind: 'release', id: 'abc-123' })
    expect(parseAgentsInput('release')).toEqual({ kind: 'error', text: 'Usage: /agents release <id>' })
    expect(parseAgentsInput('release')).toMatchObject({ kind: 'error' })
    // Legacy forms unchanged.
    expect(parseAgentsInput('')).toEqual({ kind: 'list' })
    expect(parseAgentsInput('abc-123')).toEqual({ kind: 'detail', id: 'abc-123' })
    expect(parseAgentsInput('stop abc-123')).toEqual({ kind: 'stop', id: 'abc-123' })
  })
})

describe('denyCodeOf', () => {
  it('extracts the bracketed gate code', () => {
    expect(denyCodeOf('[PIN_ORPHANED] no persisted session')).toBe('PIN_ORPHANED')
    expect(denyCodeOf('no code here')).toBeUndefined()
  })
})

// --- plugin wiring ----------------------------------------------------------

function makeFakeAgent(ctx: Context, sessionId: string, status: 'idle' | 'running' = 'idle'): Agent {
  const session = ctx.sessions.create(SessionId(sessionId))
  return {
    id: sessionId,
    options: {},
    session,
    inbox: null as never,
    ctx: new Context(),
    get status(): 'idle' | 'running' { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

describe('/agents human command', () => {
  async function harness(services: ReturnType<typeof makeServices>) {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    ctx.provide('subagents', services)
    ctx.provide('resumePinStore', { read: services.readPin, pathFor: services.pinPath })
    await ctx.plugin(commandAgents)
    const agent = makeFakeAgent(ctx, `agents-${Math.random()}`)
    await ctx.agents.register(agent)
    return { ctx, agent, services }
  }

  it('publishes the read-only ccAgents snapshot service on the root context', async () => {
    const { ctx, services } = await harness(makeServices([{ id: 'c1', mode: 'continuable', label: 'x' }]))
    const snapshot = ctx.get('ccAgents') as { list(parent: string): Promise<AgentRow[]> } | undefined
    expect(snapshot).toBeDefined()
    const list = await snapshot!.list('parent-1')
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('c1')
    expect(services.interrupts).toHaveLength(0)
  })

  it('executes /agents, /agents <id>, and stop through the command registry', async () => {
    const { ctx, agent, services } = await harness(makeServices(
      [{ id: 'pinned-deny', mode: 'continuable', label: 'fast work' }],
      { 'pinned-deny': { status: 'running' } },
    ))
    // Live child in the agents registry: makes the residency derive 'running'.
    await ctx.agents.register(makeFakeAgent(ctx, 'pinned-deny', 'running'))
    const listText = await (ctx.commands.execute(agent, '/agents', [], new AbortController().signal) as Promise<{ result?: { text?: string } }>)
      .then(r => r.result?.text ?? '')
    expect(listText).toContain('[gate: WORKSPACE_CHANGED]')
    const detailText = await (ctx.commands.execute(agent, '/agents pinned-deny', [], new AbortController().signal) as Promise<{ result?: { text?: string } }>)
      .then(r => r.result?.text ?? '')
    expect(detailText).toContain('project')
    expect(detailText).toContain('[WORKSPACE_CHANGED]')
    const stopText = await (ctx.commands.execute(agent, '/agents stop pinned-deny', [], new AbortController().signal) as Promise<{ result?: { text?: string } }>)
      .then(r => r.result?.text ?? '')
    expect(stopText).toContain('pinned-deny')
    expect(services.interrupts).toHaveLength(1)
    const idleText = await (ctx.commands.execute(agent, '/agents stop nope', [], new AbortController().signal) as Promise<{ result?: { text?: string } }>)
      .then(r => r.result?.text ?? '')
    expect(idleText).toContain('No agent')
    expect(services.interrupts).toHaveLength(1)
  })
})

describe('/agents help interception', () => {
  async function harness(): Promise<{ ctx: Context; agent: Agent }> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    const services = makeServices([])
    ctx.provide('subagents', services)
    ctx.provide('resumePinStore', { read: services.readPin, pathFor: services.pinPath })
    await ctx.plugin(commandAgents)
    const agent = makeFakeAgent(ctx, `agents-help-${Math.random()}`)
    await ctx.agents.register(agent)
    return { ctx, agent }
  }

  it('answers a trailing help argument with formatted help text', async () => {
    const { ctx, agent } = await harness()
    const text = await (ctx.commands.execute(agent, '/agents help', [], new AbortController().signal) as Promise<{ result?: { text?: string } }>)
      .then(r => r.result ?? { text: undefined })
      .then(r => r.text ?? '')
    expect(text).toContain('/agents')
    expect(text).toContain('Usage:')
    expect(text).toContain('detail')
    expect(text).toContain('stop')
  })
})

// --- release valve (T20–T22) -------------------------------------------------

interface ReleaseHarnessOptions {
  /** The catalog rows listChildren answers (or a thrower), or 'absent'. */
  children?: readonly FakeChild[]
  listChildrenThrows?: boolean
  /** The drain stub; receives the raw args for assertions. */
  drain?: (parent: unknown, ids: unknown[]) => Promise<void>
}

describe('/agents release <id> (T20–T22)', () => {
  beforeEach(() => { resetReleasedMarkers() })

  async function harness(opts: ReleaseHarnessOptions = {}) {
    const drains: { parent: unknown; ids: unknown[] }[] = []
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    const services = {
      listChildren:
        opts.listChildrenThrows === true
          ? async () => { throw new Error('catalog io failed') }
          : async () => opts.children ?? [],
      interrupt: () => {},
      ...(opts.drain === undefined ? {} : {
        drainContinuableChildren: async (parent: unknown, ids: unknown[]) => {
          drains.push({ parent, ids })
          await opts.drain(parent, ids)
        },
      }),
    }
    ctx.provide('subagents', services)
    ctx.provide('resumePinStore', { read: () => undefined, pathFor: (id: string) => `/p/${id}.json` })
    await ctx.plugin(commandAgents)
    const agent = makeFakeAgent(ctx, `rel-${Math.random()}`)
    await ctx.agents.register(agent)
    const execute = (input: string, signal?: AbortSignal) =>
      (ctx.commands.execute(agent, input, [], signal ?? new AbortController().signal) as Promise<{ result?: { text?: string } }>)
        .then(r => r.result?.text ?? '')
    return { ctx, agent, drains, execute }
  }

  /** Register a controllable live agent; returns the detach closure (the fake eviction). */
  async function registerLive(
    ctx: Context,
    id: string,
    status: 'idle' | 'running' = 'running',
  ): Promise<() => void> {
    const fake = {
      id,
      options: {},
      session: ctx.sessions.create(SessionId(id)),
      inbox: null as never,
      ctx: new Context(),
      get status(): 'idle' | 'running' { return status },
      send: () => {}, followup: () => {}, steer: () => {}, inject: () => {},
      cancel: () => {}, runMaintenance: (task: (s: AbortSignal) => unknown) => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    return await ctx.agents.register(fake as unknown as Agent)
  }

  it('T20 matrix: unknown-id / not-resident / idle / running / no-drain-seam / not-continuable / not-direct-child / catalog-unreadable', async () => {
    // unknown-id: clean catalog miss + registry miss (a drain stub exists so
    // the unknown-id gate — not no-drain-seam — fires).
    const unknown = await harness({ children: [], drain: async () => {} })
    expect(await unknown.execute('/agents release ghost'))
      .toBe("No agent ghost among this session's continuable children; use list_agents or /agents for current ids.")
    expect(unknown.drains).toHaveLength(0)

    // not-resident: catalog hit continuable + registry miss, NO drain.
    const settled = await harness({ children: [{ id: 'c1', mode: 'continuable' }], drain: async () => {} })
    expect(await settled.execute('/agents release c1'))
      .toBe('Agent c1 has no resident activation (settled or released); nothing was evicted and no capacity slot is held by it.')
    expect(settled.drains).toHaveLength(0)

    // idle + running: the drain detaches the live agent (the fake eviction).
    const detachIdle = { fn: () => {} }
    const idle = await harness({
      children: [{ id: 'idle-1', mode: 'continuable' }],
      drain: async () => { detachIdle.fn() },
    })
    detachIdle.fn = await registerLive(idle.ctx, 'idle-1', 'idle')
    expect(await idle.execute('/agents release idle-1'))
      .toBe(
        'Released agent idle-1: its resident (idle) activation was evicted; it held no capacity slot '
        + '(only running children count toward the 25-child guard). Its resident descendants (if any) '
        + 'were evicted with it. The persisted session survives on disk; within this session it cannot '
        + 'be continued (upstream cold-resume-after-drain gap); /agents marks it [released] for the '
        + 'rest of this process.',
      )

    const detachRun = { fn: () => {} }
    const running = await harness({
      children: [{ id: 'run-1', mode: 'continuable' }],
      drain: async () => { detachRun.fn() },
    })
    detachRun.fn = await registerLive(running.ctx, 'run-1', 'running')
    expect(await running.execute('/agents release run-1'))
      .toBe(
        'Released agent run-1: its in-flight turn was aborted and its resident activation evicted — '
        + 'the capacity slot it held is free. Its resident descendants (if any) were evicted with it. '
        + 'The persisted session survives on disk. Within this session it cannot be continued '
        + '(send_message resolves but runs no turn — upstream cold-resume-after-drain gap); /agents '
        + 'marks it [released] for the rest of this process.',
      )

    // no-drain-seam: the service exposes no drainContinuableChildren.
    const noSeam = await harness({ children: [{ id: 'c2', mode: 'continuable' }] })
    expect(await noSeam.execute('/agents release c2'))
      .toBe(
        "Cannot release c2: this composition's subagents seam exposes no drainContinuableChildren; "
        + 'free capacity by letting children settle or by restarting the session.',
      )

    // not-continuable: a one-shot row.
    const detachOneShot = { fn: () => {} }
    const oneShot = await harness({
      children: [{ id: 'one-1', mode: 'one-shot' }],
      drain: async () => { detachOneShot.fn() },
    })
    detachOneShot.fn = await registerLive(oneShot.ctx, 'one-1', 'running')
    expect(await oneShot.execute('/agents release one-1'))
      .toBe('Agent one-1 is not a continuable child (mode: one-shot); release only covers continuable children.')
    expect(oneShot.drains).toHaveLength(0)

    // not-direct-child: the drain refuses by lineage.
    const lineage = await harness({
      children: [{ id: 'c3', mode: 'continuable' }],
      drain: async () => { throw new Error('subagent "c3" is not a direct child of agent "other"') },
    })
    await registerLive(lineage.ctx, 'c3', 'running')
    expect(await lineage.execute('/agents release c3'))
      .toBe(
        'Agent c3 is not a direct child of this session (the drain seam refused with UNAUTHORIZED); '
        + "release its direct parent instead — if that parent is one of this session's children. "
        + 'Releasing a parent evicts its whole resident subtree.',
      )

    // catalog-unreadable: listing throws + registry miss → refuse blind, no drain.
    const unreadable = await harness({ listChildrenThrows: true, drain: async () => {} })
    expect(await unreadable.execute('/agents release c4'))
      .toBe(
        "Cannot verify c4 against this session's child catalog (catalog io failed); refusing to "
        + 'release blind. Retry, or restart the session if listing stays broken.',
      )
    expect(unreadable.drains).toHaveLength(0)
  })

  it('T20 matrix: issued-unobservable (registry get throws) renders the no-mark copy', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    const drains: unknown[][] = []
    ctx.provide('subagents', {
      listChildren: async () => [{ id: 'c5', mode: 'continuable' }],
      interrupt: () => {},
      drainContinuableChildren: async (_parent: unknown, ids: unknown[]) => { drains.push(ids) },
    })
    ctx.provide('resumePinStore', { read: () => undefined, pathFor: (id: string) => `/p/${id}.json` })
    await ctx.plugin(commandAgents)
    const caller = makeFakeAgent(ctx, `rel-x-${Math.random()}`)
    await ctx.agents.register(caller)
    // A live agent whose status getter throws: the guarded registry read
    // degrades to unobservable end to end.
    const broken = {
      id: 'c5',
      options: {},
      session: ctx.sessions.create(SessionId('c5')),
      inbox: null as never,
      ctx: new Context(),
      get status(): 'idle' | 'running' { throw new Error('registry face exploded') },
      send: () => {}, followup: () => {}, steer: () => {}, inject: () => {},
      cancel: () => {}, runMaintenance: (task: (s: AbortSignal) => unknown) => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    await ctx.agents.register(broken as unknown as Agent)
    const text = await (ctx.commands.execute(caller, '/agents release c5', [], new AbortController().signal) as Promise<{ result?: { text?: string } }>)
      .then(r => r.result?.text ?? '')
    expect(text).toBe(
      'Release of agent c5 was issued against the authoritative drain seam; this composition cannot '
      + 'observe the registry, so residency after the drain could not be confirmed and the child is '
      + 'NOT marked released. Eviction, when it applies, also covers resident descendants. If it was '
      + "resident, the drain evicts it by the seam's own contract; its continuation state here is unknown.",
    )
    expect(drains).toHaveLength(1)
    expect(isReleasing('c5')).toBe(false)
    expect(isReleased('c5')).toBe(false)
  })

  it('T20 abort pins: abort DURING listChildren (no drain) and at the pre-issuance checkpoint (no mark, no drain)', async () => {
    // CommandRuntime's own signal race rejects outside the awaited chain when
    // an invocation signal aborts; record the process-level rejections so the
    // pins stay deterministic about OUR state (drain, markers).
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      // (1) abort while the listing is in flight: the abort propagates, no drain.
      const controller1 = new AbortController()
      const duringListing = await harness({
        children: [{ id: 'c6', mode: 'continuable' }],
        drain: async () => {},
      })
      const services = duringListing.ctx.get('subagents') as unknown as {
        listChildren: (id: unknown, signal?: AbortSignal) => Promise<unknown>
      }
      const original = services.listChildren
      services.listChildren = async (id: unknown, signal?: AbortSignal) => {
        controller1.abort()
        signal?.throwIfAborted()
        return await original(id, signal)
      }
      await duringListing.ctx.commands.execute(duringListing.agent, '/agents release c6', [], controller1.signal).catch(() => {})
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(duringListing.drains).toHaveLength(0)
      expect(isReleasing('c6')).toBe(false)
      expect(unhandled.some(reason => String(reason).includes('abort'))).toBe(true)

      // (2) abort after a successful listing, before issuance: no mark, no drain.
      const controller2 = new AbortController()
      const beforeIssuance = await harness({
        children: [{ id: 'c7', mode: 'continuable' }],
        drain: async () => {},
      })
      const pending = beforeIssuance.ctx.commands.execute(beforeIssuance.agent, '/agents release c7', [], controller2.signal) as Promise<unknown>
      await new Promise(resolve => setTimeout(resolve, 10))
      controller2.abort()
      await pending.catch(() => {})
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(beforeIssuance.drains).toHaveLength(0)
      expect(isReleasing('c7')).toBe(false)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('T21: help renders the release row and the amended stop summary', async () => {
    const { execute } = await harness()
    const text = await execute('/agents help')
    expect(text).toContain('release')
    expect(text).toContain(
      "Evict an agent's resident activation (and resident descendants'), freeing its capacity slot "
      + 'when it was running; cooperative; one-way in this session',
    )
    expect(text).toContain(
      'Interrupt a running agent\'s current turn (the activation stays resident; "/agents release <id>" evicts it)',
    )
  })

  it('T22: [released] only when marker && residency ready; detail line on an UNPINNED row; stopReleasedCopy on stop-of-released', async () => {
    // Tagged ready row renders [released] in the list.
    markReleased('tagged')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    ctx.provide('subagents', {
      listChildren: async () => [
        { id: 'tagged', mode: 'continuable' },
        { id: 'live', mode: 'continuable' },
      ],
      interrupt: () => {},
    })
    ctx.provide('resumePinStore', { read: () => undefined, pathFor: (id: string) => `/p/${id}.json` })
    await ctx.plugin(commandAgents)
    const caller = makeFakeAgent(ctx, `tag-${Math.random()}`)
    await ctx.agents.register(caller)
    await registerLive(ctx, 'live', 'running')
    const list = await (ctx.commands.execute(caller, '/agents', [], new AbortController().signal) as Promise<{ result?: { text?: string } }>)
      .then(r => r.result?.text ?? '')
    expect(list).toContain('[released]')
    const taggedIndex = list.indexOf('tagged')
    expect(list.indexOf('[released]')).toBeGreaterThan(taggedIndex)
    // The live (running) row is rendered but never tagged.
    expect(list).toContain('live')
    expect((list.match(/\[released\]/g) ?? []).length).toBe(1)

    // Detail line on an UNPINNED tagged row (bare-id detail form).
    const detail = await (ctx.commands.execute(caller, '/agents tagged', [], new AbortController().signal) as Promise<{ result?: { text?: string } }>)
      .then(r => r.result?.text ?? '')
    expect(detail).toContain(
      'released: this process — resident activation evicted or release in flight; '
      + 'same-session continuation unavailable (upstream gap)',
    )
    expect(detail).toContain('pin: none')

    // stop-of-released: the gate renders stopReleasedCopy instead of the
    // stopNotRunningCopy early-return.
    const stop = await (ctx.commands.execute(caller, '/agents stop tagged', [], new AbortController().signal) as Promise<{ result?: { text?: string } }>)
      .then(r => r.result?.text ?? '')
    expect(stop).toBe(
      'Agent tagged was released (or its release is in flight) in this process; it cannot be '
      + 'continued here — nothing to stop.',
    )
  })
})
