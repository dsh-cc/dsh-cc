import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as commandAgents from '@dsh-cc/command-agents'
import {
  isReleased,
  isReleasing,
  markReleased,
  resetReleasedMarkers,
  type ReleaseDisposalsLike,
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
  /** Child ids that carry durable sub-descendants (rc.5 `listDescendants` `kind: 'child'` rows). */
  descendantParents: Map<string, boolean> = new Map(),
): SnapshotServices & {
  interrupts: { id: string; authority: unknown }[]
} {
  const interrupts: { id: string; authority: unknown }[] = []
  return {
    listChildren: async () => children,
    // rc.5 descendant rows: direct children are depth-1 `kind: 'child'` rows;
    // the `[has children]` tag folds from the same walk.
    listDescendants: async () => children.map(child => ({
      ...child,
      kind: 'child',
      depth: 1,
      hasChildren: descendantParents.get(child.id) === true,
    })),
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

/** The dormant receipt-registry fake every mounted harness provides (inject). */
function makeIdleDisposals(): ReleaseDisposalsLike {
  return { tryDispose: async () => ({ held: false, cause: 'no-receipt' as const }) }
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

  it('skips one-shot rows: ephemeral children are not /agents-listable (snapshot.ts)', async () => {
    const services = makeServices([
      { id: 'eph-1', mode: 'one-shot', label: 'explore' },
      { id: 'cont-1', mode: 'continuable', label: 'worker' },
    ])
    expect(await rows(services)).toEqual([
      { id: 'cont-1', label: 'worker', residency: 'ready', hasChildren: false, parentId: PARENT, pin: undefined },
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

  it('the descendant walk failing degrades the [has children] tag but not the rows', async () => {
    const services = makeServices([{ id: 'c9', mode: 'continuable' }], {}, new Map([['c9', true]]))
    expect((await rows(services))[0]!.hasChildren).toBe(true)
    // A throwing descendant seam: the host adapter degrades read-side; here
    // the snapshot's own catch keeps the tag absent while the row remains.
    const degraded = {
      ...services,
      listChildren: services.listChildren,
      listDescendants: async () => { throw new Error('projection unavailable') },
    }
    expect((await buildAgentsSnapshot(degraded, PARENT))[0]!.hasChildren).toBe(false)
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

/** Compose the session/command/runtime backbone; caller provides the seams. */
async function backbone(ctx: Context): Promise<void> {
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
}

describe('/agents human command', () => {
  async function harness(services: ReturnType<typeof makeServices>) {
    const ctx = new Context()
    await backbone(ctx)
    ctx.provide('subagents', services)
    ctx.provide('resumePinStore', { read: services.readPin, pathFor: services.pinPath })
    ctx.provide('ccContinuableDisposals', makeIdleDisposals())
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

  it('a listDescendants that throws SubagentError-style degrades /agents to the empty list (rc.5 service-throw guard)', async () => {
    const ctx = new Context()
    await backbone(ctx)
    ctx.provide('subagents', {
      listDescendants: async () => { throw new Error('SUBAGENT_CONTROL_UNAVAILABLE: sessionQuery is not mounted') },
      interrupt: () => {},
    })
    ctx.provide('resumePinStore', { read: () => undefined, pathFor: (id: string) => `/p/${id}.json` })
    ctx.provide('ccContinuableDisposals', makeIdleDisposals())
    await ctx.plugin(commandAgents)
    const agent = makeFakeAgent(ctx, `agents-degraded-${Math.random()}`)
    await ctx.agents.register(agent)
    const text = await (ctx.commands.execute(agent, '/agents', [], new AbortController().signal) as Promise<{ result?: { text?: string } }>)
      .then(r => r.result?.text ?? '')
    expect(text).toBe('No background agents.')
  })
})

describe('/agents help interception', () => {
  async function harness(): Promise<{ ctx: Context; agent: Agent }> {
    const ctx = new Context()
    await backbone(ctx)
    const services = makeServices([])
    ctx.provide('subagents', services)
    ctx.provide('resumePinStore', { read: services.readPin, pathFor: services.pinPath })
    ctx.provide('ccContinuableDisposals', makeIdleDisposals())
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

interface FakeDescendantRow {
  id: string
  mode?: 'one-shot' | 'continuable'
  label?: string
  /** Depth from the release root; 1 = direct child, deeper = refused lineage. */
  depth?: number
  kind?: 'child' | 'diagnostic'
  reason?: string
}

interface ReleaseHarnessOptions {
  /** The descendant rows listDescendants answers (fallback: direct children). */
  descendants?: readonly FakeDescendantRow[]
  listDescendantsThrows?: boolean
  /** When 'absent', the harness is built WITHOUT a ccContinuableDisposals. */
  disposals?: 'absent'
}

describe('/agents release <id> (T20–T22)', () => {
  beforeEach(() => { resetReleasedMarkers() })

  function childDescendant(id: string, mode: 'one-shot' | 'continuable' = 'continuable'): FakeDescendantRow {
    return { id, mode, depth: 1, kind: 'child' }
  }

  async function harness(opts: ReleaseHarnessOptions = {}) {
    const disposeCalls: { parent: unknown; child: unknown }[] = []
    const disposers = new Map<string, () => void>()
    const ctx = new Context()
    await backbone(ctx)
    const services = {
      listDescendants:
        opts.listDescendantsThrows === true
          ? async () => { throw new Error('catalog io failed') }
          : async () => (opts.descendants ?? []).map(row => ({ depth: 1, kind: 'child', ...row })),
      interrupt: () => {},
    }
    ctx.provide('subagents', services)
    ctx.provide('resumePinStore', { read: () => undefined, pathFor: (id: string) => `/p/${id}.json` })
    // The receipt-registry fake: held:true with a disposed promise that runs
    // the per-test disposer (the fake eviction) when the body registers one.
    const disposals: ReleaseDisposalsLike = {
      tryDispose: async (parent, child) => {
        disposeCalls.push({ parent, child })
        const key = String(child)
        return {
          held: true,
          disposed: Promise.resolve().then(() => disposers.get(key)?.()),
        }
      },
    }
    if (opts.disposals === 'absent') {
      // Direct apply(): the inject-gated loader path always has the service
      // in production; this composition honestly has none (Step 0).
      commandAgents.apply(ctx)
    } else {
      ctx.provide('ccContinuableDisposals', disposals)
      await ctx.plugin(commandAgents)
    }
    const agent = makeFakeAgent(ctx, `rel-${Math.random()}`)
    await ctx.agents.register(agent)
    const execute = (input: string, signal?: AbortSignal) =>
      (ctx.commands.execute(agent, input, [], signal ?? new AbortController().signal) as Promise<{ result?: { text?: string } }>)
        .then(r => r.result?.text ?? '')
    return { ctx, agent, disposeCalls, disposers, execute }
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

  it('T20 matrix: unknown-id / not-resident / idle / running / no-disposals / not-continuable / not-direct-child / catalog-unreadable', async () => {
    // unknown-id: clean catalog miss + registry miss (the receipts exist so
    // the unknown-id gate — not no-disposals — fires).
    const unknown = await harness({ descendants: [] })
    expect(await unknown.execute('/agents release ghost'))
      .toBe("No agent ghost among this session's continuable children; use list_agents or /agents for current ids.")
    expect(unknown.disposeCalls).toHaveLength(0)

    // not-resident: catalog hit continuable + registry miss, NO disposal.
    const settled = await harness({ descendants: [childDescendant('c1')] })
    expect(await settled.execute('/agents release c1'))
      .toBe('Agent c1 has no resident activation (settled or released); nothing was evicted and no capacity slot is held by it.')
    expect(settled.disposeCalls).toHaveLength(0)

    // idle + running: the dispose detaches the live agent (the fake eviction).
    const idle = await harness({ descendants: [childDescendant('idle-1')] })
    idle.disposers.set('idle-1', await registerLive(idle.ctx, 'idle-1', 'idle'))
    expect(await idle.execute('/agents release idle-1'))
      .toBe(
        'Released agent idle-1: its resident (idle) activation was evicted — the capacity slot it held '
        + 'is free. Its resident delegates (if any) are unaffected and must be released individually. '
        + 'The persisted session survives on disk; within this session it cannot be continued '
        + '(upstream cold-resume-after-drain gap); /agents marks it [released] for the rest of this process.',
      )

    const running = await harness({ descendants: [childDescendant('run-1')] })
    running.disposers.set('run-1', await registerLive(running.ctx, 'run-1', 'running'))
    expect(await running.execute('/agents release run-1'))
      .toBe(
        'Released agent run-1: its in-flight turn was aborted and its resident activation evicted — '
        + 'the capacity slot it held is free. Its resident delegates (if any) are unaffected and must '
        + 'be released individually. The persisted session survives on disk. Within this session it '
        + 'cannot be continued (send_message resolves but runs no turn — upstream cold-resume-after-drain '
        + 'gap); /agents marks it [released] for the rest of this process.',
      )

    // no-disposals: this composition does not publish ccContinuableDisposals.
    const noService = await harness({ descendants: [childDescendant('c2')], disposals: 'absent' })
    expect(await noService.execute('/agents release c2'))
      .toBe('Cannot release c2: the ccContinuableDisposals service is not available in this composition.')

    // not-continuable: a one-shot row.
    const oneShot = await harness({ descendants: [childDescendant('one-1', 'one-shot')] })
    await registerLive(oneShot.ctx, 'one-1', 'running')
    expect(await oneShot.execute('/agents release one-1'))
      .toBe('Agent one-1 is not a continuable child (mode: one-shot); release only covers continuable children.')
    expect(oneShot.disposeCalls).toHaveLength(0)

    // not-direct-child: a deeper descendant row (grandchild lineage) refused
    // BEFORE any dispose attempt.
    const lineage = await harness({ descendants: [{ ...childDescendant('c3'), depth: 2 }] })
    await registerLive(lineage.ctx, 'c3', 'running')
    expect(await lineage.execute('/agents release c3'))
      .toBe('Agent c3 is not a direct child of this session; only its creating session (its direct parent) can release it.')
    expect(lineage.disposeCalls).toHaveLength(0)

    // catalog-unreadable: the descendant listing throws + registry miss →
    // refuse blind, no disposal.
    const unreadable = await harness({ listDescendantsThrows: true })
    expect(await unreadable.execute('/agents release c4'))
      .toBe(
        "Cannot verify c4 against this session's child catalog (catalog io failed); refusing to "
        + 'release blind. Retry, or restart the session if listing stays broken.',
      )
    expect(unreadable.disposeCalls).toHaveLength(0)
  })

  it('T20 matrix: issued-unobservable (registry get throws) renders the no-mark copy', async () => {
    const ctx = new Context()
    await backbone(ctx)
    const disposeCalls: unknown[][] = []
    ctx.provide('subagents', {
      listDescendants: async () => [{ id: 'c5', mode: 'continuable', depth: 1, kind: 'child' }],
      interrupt: () => {},
    })
    ctx.provide('resumePinStore', { read: () => undefined, pathFor: (id: string) => `/p/${id}.json` })
    ctx.provide('ccContinuableDisposals', {
      tryDispose: async (parent: unknown, child: unknown) => {
        disposeCalls.push([parent, child])
        return { held: true as const, disposed: Promise.resolve() }
      },
    } satisfies ReleaseDisposalsLike)
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
      + 'NOT marked released. Eviction, when it applies, covers the named child only — its resident '
      + "delegates are unaffected. If it was resident, the drain evicts it by the seam's own contract; "
      + 'its continuation state here is unknown.',
    )
    expect(disposeCalls).toHaveLength(1)
    expect(isReleasing('c5')).toBe(false)
    expect(isReleased('c5')).toBe(false)
  })

  it('T20 abort pins: abort DURING listDescendants (no disposal) and at the pre-issuance checkpoint (no mark, no disposal)', async () => {
    // CommandRuntime's own signal race rejects outside the awaited chain when
    // an invocation signal aborts; record the process-level rejections so the
    // pins stay deterministic about OUR state (disposal, markers).
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      // (1) abort while the listing is in flight: the abort propagates, no disposal.
      const controller1 = new AbortController()
      const duringListing = await harness({ descendants: [childDescendant('c6')] })
      const services = duringListing.ctx.get('subagents') as unknown as {
        listDescendants: (id: unknown, signal?: AbortSignal) => Promise<unknown>
      }
      const original = services.listDescendants
      services.listDescendants = async (id: unknown, signal?: AbortSignal) => {
        controller1.abort()
        signal?.throwIfAborted()
        return await original(id, signal)
      }
      await duringListing.ctx.commands.execute(duringListing.agent, '/agents release c6', [], controller1.signal).catch(() => {})
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(duringListing.disposeCalls).toHaveLength(0)
      expect(isReleasing('c6')).toBe(false)
      expect(unhandled.some(reason => String(reason).includes('abort'))).toBe(true)

      // (2) abort after a successful listing, before issuance: no mark, no disposal.
      const controller2 = new AbortController()
      const beforeIssuance = await harness({ descendants: [childDescendant('c7')] })
      const pending = beforeIssuance.ctx.commands.execute(beforeIssuance.agent, '/agents release c7', [], controller2.signal) as Promise<unknown>
      await new Promise(resolve => setTimeout(resolve, 10))
      controller2.abort()
      await pending.catch(() => {})
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(beforeIssuance.disposeCalls).toHaveLength(0)
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
      "Evict an agent's resident activation, freeing the capacity slot it held (its delegates are "
      + 'unaffected); cooperative; one-way in this session',
    )
    expect(text).toContain(
      'Interrupt a running agent\'s current turn (the activation stays resident; "/agents release <id>" evicts it)',
    )
  })

  it('T22: [released] only when marker && residency ready; detail line on an UNPINNED row; stopReleasedCopy on stop-of-released', async () => {
    // Tagged ready row renders [released] in the list.
    markReleased('tagged')
    const ctx = new Context()
    await backbone(ctx)
    ctx.provide('subagents', {
      listDescendants: async () => [
        { id: 'tagged', mode: 'continuable', depth: 1, kind: 'child' },
        { id: 'live', mode: 'continuable', depth: 1, kind: 'child' },
      ],
      interrupt: () => {},
    })
    ctx.provide('resumePinStore', { read: () => undefined, pathFor: (id: string) => `/p/${id}.json` })
    ctx.provide('ccContinuableDisposals', makeIdleDisposals())
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
