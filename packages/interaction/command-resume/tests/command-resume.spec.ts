import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as commandResume from '@dsh-cc/command-resume'
import {
  formatResumeIndex,
  formatSessionLine,
  isEphemeralOneShotSession,
  type SessionLine,
} from '@dsh-cc/command-resume/resume'

const LINES: readonly SessionLine[] = [
  {
    id: 'sess-1',
    title: 'Implement search',
    cwd: '/work/repo',
    parent: 'sess-0',
    createdAt: 1_700_000_000_000,
    live: true,
    persisted: true,
  },
  {
    id: 'sess-2',
    createdAt: 1_700_000_100_000,
    live: false,
    persisted: true,
  },
]

describe('@dsh-cc/command-resume rendering (pure)', () => {
  it('renders id, title, cwd, parent, availability, and creation time', () => {
    const text = formatResumeIndex(LINES)
    expect(text).toContain('- sess-1 — Implement search — cwd: /work/repo — parent: sess-0 — available — created 2023-11-14T22:13:20.000Z')
    expect(text).toContain('- sess-2 — persisted')
  })
  it('ends with the host-owned resume switch instruction', () => {
    expect(formatResumeIndex(LINES)).toContain('To switch, restart with: dsh --resume <sessionId>')
    expect(formatResumeIndex([])).toContain('No sessions are available to resume.')
    expect(formatResumeIndex([])).toContain('dsh --resume <sessionId>')
  })
  it('formats a single line, omitting absent fields', () => {
    expect(formatSessionLine({ id: 's', createdAt: 0, live: true, persisted: false })).toContain('- s')
  })
})

describe('ephemeral one-shot /resume filter (design 2026-10-04 §3.5)', () => {
  const oneShot = new Set(['eph-1'])

  it('filters a parented session the ledger marks one-shot', () => {
    expect(isEphemeralOneShotSession({ id: 'eph-1', parentSession: 'p' }, oneShot)).toBe(true)
  })

  it('keeps a continuable child session (not in the one-shot set)', () => {
    expect(isEphemeralOneShotSession({ id: 'cont-1', parentSession: 'p' }, oneShot)).toBe(false)
  })

  it('keeps root sessions even if an id collides', () => {
    expect(isEphemeralOneShotSession({ id: 'eph-1' }, oneShot)).toBe(false)
  })
})

describe('/resume human command', () => {
  async function harness(seam?: {
    listSessions(signal?: AbortSignal): Promise<{ header: { id: string; cwd?: string; parentSession?: string; createdAt: number }; live: boolean; persisted: boolean }[]>
    readTitleSnapshots(ids: readonly string[]): Promise<{ sessionId: string; status: 'fulfilled'; value: { title?: { title: string } } }[]>
  }) {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    if (seam) ctx.provide('sessionQuery', seam)
    await ctx.plugin(commandResume)
    const session = ctx.sessions.create(SessionId(`command-resume-human-${Math.random()}`))
    const agent: Agent = {
      id: session.id,
      options: {},
      session,
      inbox: null as never,
      ctx: new Context(),
      get status(): 'idle' { return 'idle' },
      send: () => {},
      followup: () => {},
      steer: () => {},
      inject: () => {},
      cancel: () => {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    await ctx.agents.register(agent)
    return { ctx, agent }
  }

  it('registers one global command with Loader-safe exports', async () => {
    expect(commandResume.name).toBe('command-resume')
    expect(commandResume.inject).toEqual(['commands'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandResume)).toBe(commandResume)
    const { ctx, agent } = await harness()
    expect(ctx.commands.find(agent, 'resume')).toBeDefined()
  })

  it('degrades gracefully when the session-query seam is absent', async () => {
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/resume', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    expect((execution?.result as { text: string }).text).toContain('No session-query service is mounted')
  })

  it('lists sessions with folded titles through the seam', async () => {
    const listSessions = vi.fn(async () => [
      { header: { id: 'sess-1', cwd: '/work/repo', parentSession: 'sess-0', createdAt: 1_700_000_000_000 }, live: true, persisted: true },
    ])
    const readTitleSnapshots = vi.fn(async (ids: readonly string[]) =>
      ids.map(id => ({ sessionId: id, status: 'fulfilled' as const, value: { title: { title: 'Implement search' } } })),
    )
    const { ctx, agent } = await harness({ listSessions, readTitleSnapshots })
    const execution = await ctx.commands.execute(agent, '/resume', [], new AbortController().signal)
    expect((execution?.result as { text: string }).text).toContain('- sess-1 — Implement search')
    expect((execution?.result as { text: string }).text).toContain('dsh --resume <sessionId>')
  })

  it('filters ephemeral one-shot children via the ccOneShotLedger service; keeps continuable children', async () => {
    const listSessions = async () => [
      { header: { id: 'eph-1', parentSession: 'sess-0', createdAt: 1_700_000_000_000 }, live: true, persisted: true },
      { header: { id: 'cont-1', parentSession: 'sess-0', createdAt: 1_700_000_000_000 }, live: true, persisted: true },
      { header: { id: 'root-1', createdAt: 1_700_000_000_000 }, live: true, persisted: true },
    ]
    const readTitleSnapshots = async (ids: readonly string[]) =>
      ids.map(id => ({ sessionId: id, status: 'fulfilled' as const, value: {} }))
    const { ctx, agent } = await harness({ listSessions, readTitleSnapshots })
    // Root-realm publication, as the cc-subagent-task plugin does.
    ctx.provide('ccOneShotLedger', { oneShotChildIds: () => new Set(['eph-1']) })
    const execution = await ctx.commands.execute(agent, '/resume', [], new AbortController().signal)
    const text = (execution?.result as { text: string }).text
    expect(text).not.toContain('- eph-1')
    expect(text).toContain('- cont-1')
    expect(text).toContain('- root-1')
  })

  it('renders the switch instruction even with no sessions', async () => {
    const { ctx, agent } = await harness({ listSessions: async () => [], readTitleSnapshots: async () => [] })
    const execution = await ctx.commands.execute(agent, '/resume', [], new AbortController().signal)
    expect((execution?.result as { text: string }).text).toContain('No sessions are available to resume.')
  })
})


describe('/resume trailing help request', () => {
  it('answers `/resume help` with the rendered usage text, not a model turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(commandResume)
  const session = ctx.sessions.create(SessionId(`resume-${Math.random()}`))
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: null as never,
    ctx: new Context(),
    get status(): 'idle' { return 'idle' },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  return agent
    const execution = await ctx.commands.execute(agent, '/resume help', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('/resume')
    expect(text).toContain('Usage:')
  })
})
