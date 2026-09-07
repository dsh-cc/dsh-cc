import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as commandAgents from '@dsh-cc/command-agents'
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

interface FakeChild {
  id: string
  activity: 'running' | 'inactive'
  hasChildren: boolean
  mode?: 'one-shot' | 'continuable'
  label?: string
}

function makeServices(children: readonly FakeChild[], agents: Record<string, { status?: string }> = {}): SnapshotServices & {
  interrupts: { id: string; authority: unknown }[]
} {
  const interrupts: { id: string; authority: unknown }[] = []
  return {
    listChildren: async () => children,
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
      [{ id: 'c1', activity: 'running', hasChildren: false, mode: 'continuable', label: 'scout' }],
      { c1: { status: 'running' } },
    )
    expect(await rows(services)).toEqual([
      { id: 'c1', label: 'scout', residency: 'running', hasChildren: false, parentId: PARENT, pin: undefined },
    ])
  })

  it('derives idle: live agent present but not running', async () => {
    const services = makeServices(
      [{ id: 'c2', activity: 'running', hasChildren: false, mode: 'continuable', label: 'worker' }],
      { c2: { status: 'idle' } },
    )
    expect((await rows(services))[0]!.residency).toBe('idle')
  })

  it('derives ready: activity running but no live agent (settled continuable)', async () => {
    const services = makeServices([{ id: 'c3', activity: 'running', hasChildren: true, mode: 'continuable', label: 'done-child' }])
    expect((await rows(services))[0]!.residency).toBe('ready')
  })

  it('derives ready: persistence-only child (activity inactive)', async () => {
    const services = makeServices([{ id: 'c4', activity: 'inactive', hasChildren: false, mode: 'continuable', label: 'parked' }])
    expect((await rows(services))[0]!.residency).toBe('ready')
  })

  it('attaches pin state including gate deny code', async () => {
    const services = makeServices([
      { id: 'pinned-ok', activity: 'inactive', hasChildren: false, mode: 'continuable', label: 'a' },
      { id: 'pinned-deny', activity: 'inactive', hasChildren: false, mode: 'continuable', label: 'b' },
      { id: 'pinned-corrupt', activity: 'inactive', hasChildren: false, mode: 'continuable', label: 'c' },
      { id: 'unpinned', activity: 'inactive', hasChildren: false, mode: 'continuable', label: 'd' },
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
      { id: 'ready-1', activity: 'inactive', hasChildren: false, mode: 'continuable', label: 'zzz' },
      { id: 'run-1', activity: 'running', hasChildren: false, mode: 'continuable', label: 'aaa' },
      { id: 'idle-1', activity: 'running', hasChildren: false, mode: 'continuable', label: 'bbb' },
      { id: 'pinned-deny', activity: 'inactive', hasChildren: false, mode: 'continuable', label: 'mmm' },
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
      { id: 'b', activity: 'running', hasChildren: false, mode: 'continuable', label: 'same' },
      { id: 'a', activity: 'running', hasChildren: false, mode: 'continuable', label: 'same' },
    ], { a: { status: 'running' }, b: { status: 'running' } })
    const text = renderAgentsList(await rows(services))
    expect(text.indexOf('a')).toBeLessThan(text.indexOf('b', text.indexOf('a') + 1))
  })
})

describe('renderAgentDetail', () => {
  it('renders ids, residency, children, and pin provenance', async () => {
    const services = makeServices(
      [{ id: 'pinned-ok', activity: 'inactive', hasChildren: true, mode: 'continuable', label: 'scout' }],
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
    ctx.agents.register(agent)
    return { ctx, agent, services }
  }

  it('publishes the read-only ccAgents snapshot service on the root context', async () => {
    const { ctx, services } = await harness(makeServices([{ id: 'c1', activity: 'inactive', hasChildren: false, mode: 'continuable', label: 'x' }]))
    const snapshot = ctx.get('ccAgents') as { list(parent: string): Promise<AgentRow[]> } | undefined
    expect(snapshot).toBeDefined()
    const list = await snapshot!.list('parent-1')
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('c1')
    expect(services.interrupts).toHaveLength(0)
  })

  it('executes /agents, /agents <id>, and stop through the command registry', async () => {
    const { ctx, agent, services } = await harness(makeServices(
      [{ id: 'pinned-deny', activity: 'running', hasChildren: false, mode: 'continuable', label: 'fast work' }],
      { 'pinned-deny': { status: 'running' } },
    ))
    // Live child in the agents registry: makes the residency derive 'running'.
    ctx.agents.register(makeFakeAgent(ctx, 'pinned-deny', 'running'))
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
    ctx.agents.register(agent)
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
