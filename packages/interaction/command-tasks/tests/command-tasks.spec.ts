import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as commandTasks from '@dsh-cc/command-tasks'
import {
  formatAgentsFooter,
  formatJobs,
  formatJobLine,
  type JobLine,
} from '@dsh-cc/command-tasks/tasks'

const ROWS: readonly JobLine[] = [
  { id: 'bash-1', kind: 'bash', status: 'running', startedAt: 1_700_000_000_000, label: 'npm test' },
  { id: 'subagent-2', kind: 'subagent', status: 'running', startedAt: 1_700_000_100_000 },
]

describe('@dsh-cc/command-tasks rendering (pure)', () => {
  it('renders running jobs with id, kind, status, and start time', () => {
    const text = formatJobs(ROWS)
    expect(text).toContain('- bash-1 [bash] running started: 2023-11-14T22:13:20.000Z — npm test')
    expect(text).toContain('- subagent-2 [subagent] running started: 2023-11-14T22:15:00.000Z')
  })
  it('renders an empty job set as friendly text', () => {
    expect(formatJobs([])).toContain('No background jobs are running.')
  })
  it('formats a single line', () => {
    expect(formatJobLine({ id: 'bash-1', kind: 'bash', status: 'completed', startedAt: 0 }))
      .toContain('- bash-1 [bash] completed')
  })
})

describe('/tasks human command', () => {
  async function harness(
    jobs?: { list(caller?: Agent): { id: unknown; kind: string; status: string; startedAt: number; label: string }[] },
    agentsSnapshot?: { list(parent: string): Promise<readonly unknown[]> },
  ) {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    if (jobs) ctx.provide('jobs', jobs)
    await ctx.plugin(commandTasks)
    if (agentsSnapshot !== undefined) (ctx as unknown as { root: { provide(key: string, value: unknown): void } }).root.provide('ccAgents', agentsSnapshot)
    const session = ctx.sessions.create(SessionId(`command-tasks-human-${Math.random()}`))
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
    ctx.agents.register(agent)
    return { ctx, agent }
  }

  it('registers one global command with Loader-safe exports', async () => {
    expect(commandTasks.name).toBe('command-tasks')
    expect(commandTasks.inject).toEqual(['commands', 'jobs'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandTasks)).toBe(commandTasks)
    const { ctx, agent } = await harness({ list: () => [] })
    expect(ctx.commands.find(agent, 'tasks')).toBeDefined()
  })

  it('lists caller-visible background jobs through the jobs service', async () => {
    const list = vi.fn(() => [
      { id: 'bash-1', kind: 'bash', status: 'running', startedAt: 1_700_000_000_000, label: 'npm test' },
    ])
    const { ctx, agent } = await harness({ list })
    const execution = await ctx.commands.execute(agent, '/tasks', [], new AbortController().signal)
    expect(list).toHaveBeenCalledWith(agent)
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('- bash-1 [bash] running')
  })

  it('renders a friendly empty message when no jobs are running', async () => {
    const { ctx, agent } = await harness({ list: () => [] })
    const execution = await ctx.commands.execute(agent, '/tasks', [], new AbortController().signal)
    expect((execution?.result as { text: string }).text).toContain('No background jobs are running.')
  })

  it('appends the /agents cross-link footer when the snapshot service is present', async () => {
    const { ctx, agent } = await harness(
      { list: () => [] },
      { list: async () => [{ id: 'child-1' }, { id: 'child-2' }] },
    )
    const execution = await ctx.commands.execute(agent, '/tasks', [], new AbortController().signal)
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('No background jobs are running.')
    expect(text).toContain('2 background agents — /agents for details')
  })

  it('omits the footer when no snapshot service resolves', async () => {
    const { ctx, agent } = await harness({ list: () => [] })
    const execution = await ctx.commands.execute(agent, '/tasks', [], new AbortController().signal)
    expect((execution?.result as { text: string }).text).not.toContain('/agents')
  })
})


describe('/tasks trailing help request', () => {
  it('answers `/tasks help` with the rendered usage text, not a model turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(commandTasks)
  const session = ctx.sessions.create(SessionId(`tasks-${Math.random()}`))
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
  ctx.agents.register(agent)
  return agent
    const execution = await ctx.commands.execute(agent, '/tasks help', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('/tasks')
    expect(text).toContain('Usage:')
  })
})
