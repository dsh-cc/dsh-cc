import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { CallId } from '@deepseek-ai/dsh-llm'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import * as commandStats from '@dsh-cc/command-stats'
import { foldStats, formatStatsReport } from '@dsh-cc/command-stats/stats'

function ev(type: string, data: unknown, seq: number): SessionEvent {
  return Object.freeze({ seq, time: seq * 10, type, data }) as SessionEvent
}

function turnEnd(seq: number): SessionEvent {
  return ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, seq)
}
function stepEnd(seq: number): SessionEvent {
  return ev('step/end', { turn: 1, step: 1 }, seq)
}
function user(seq: number): SessionEvent {
  return ev('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] }, seq)
}
function assistant(seq: number, input: number, output: number): SessionEvent {
  return ev('assistant/message', {
    turn: 1, step: 1,
    message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [] },
    usage: { inputTokens: input, outputTokens: output, cacheReadTokens: 5 },
  }, seq)
}
function toolCall(seq: number, name: string): SessionEvent {
  return ev('tool/call', { turn: 1, step: 1, callId: `c-${seq}`, name, arguments: '{}' }, seq)
}

async function harness(): Promise<{
  ctx: Context
  agent: Agent
  session: Session
  plugin: Awaited<ReturnType<Context['plugin']>>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  const plugin = await ctx.plugin(commandStats)
  const session = ctx.sessions.create(SessionId(`command-stats-${Math.random()}`))
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
  return { ctx, agent, session, plugin }
}

async function run(test: Awaited<ReturnType<typeof harness>>): Promise<NonNullable<Awaited<ReturnType<CommandRuntime['execute']>>>['result']> {
  const execution = await test.ctx.commands.execute(
    test.agent,
    '/stats',
    [],
    new AbortController().signal,
  )
  if (execution === undefined) throw new Error('stats command was not registered')
  return execution.result
}

describe('@dsh-cc/command-stats registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    expect(commandStats.name).toBe('command-stats')
    expect(commandStats.inject).toEqual(['commands'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandStats)).toBe(commandStats)
    const test = await harness()
    expect(test.ctx.commands.find(test.agent, 'stats')).toBeDefined()
    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'stats')).toBeUndefined()
  })
})

describe('/stats fold', () => {
  it('counts turns, steps, messages, and tool calls by name', () => {
    const events = [
      user(1), stepEnd(2), turnEnd(3),
      toolCall(4, 'read_file'), toolCall(5, 'read_file'), toolCall(6, 'grep'),
      assistant(7, 100, 20),
    ]
    const report = foldStats(events)
    expect(report).toMatchObject({ turns: 1, steps: 1, userMessages: 1, assistantMessages: 1 })
    expect(report.totalToolCalls).toBe(3)
    expect(report.toolCalls).toEqual([
      { name: 'read_file', calls: 2 },
      { name: 'grep', calls: 1 },
    ])
  })
  it('sums token usage across assistant messages', () => {
    const events = [assistant(1, 100, 20), assistant(2, 300, 40)]
    const report = foldStats(events)
    expect(report.inputTokens).toBe(400)
    expect(report.outputTokens).toBe(60)
    expect(report.cacheReadTokens).toBe(10)
    expect(report.cacheWriteTokens).toBe(0)
  })
  it('returns the empty path with all-zero figures', () => {
    const report = foldStats([ev('turn/start', { turn: 0 }, 1)])
    expect(report).toEqual({
      turns: 0, steps: 0, userMessages: 0, assistantMessages: 0,
      toolCalls: [], totalToolCalls: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    })
  })
})

describe('/stats formatting snapshot', () => {
  it('renders the empty path directly', () => {
    expect(formatStatsReport(foldStats([ev('turn/start', { turn: 0 }, 1)])))
      .toBe('No session activity yet.')
  })
  it('renders a populated report with tool distribution and token totals', () => {
    const report = foldStats([
      user(1), stepEnd(2), turnEnd(3),
      toolCall(4, 'read_file'), toolCall(5, 'read_file'), toolCall(6, 'grep'),
      assistant(7, 100, 20),
    ])
    const text = formatStatsReport(report)
    expect(text).toContain('Turns: 1')
    expect(text).toContain('Steps: 1')
    expect(text).toContain('Tool calls: 3')
    expect(text).toContain('  read_file: 2')
    expect(text).toContain('  grep: 1')
    expect(text).toContain('Token usage (input / output / cache-read / cache-write):')
    expect(text).toContain('100 / 20 / 5 / 0')
  })
})

describe('/stats human command', () => {
  it('reports no activity on an empty session', async () => {
    const test = await harness()
    await expect(run(test)).resolves.toEqual({
      kind: 'success',
      text: 'No session activity yet.',
    })
  })
  it('reports folded statistics through the registry boundary', async () => {
    const test = await harness()
    test.session.append('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'read_file', arguments: '{}' })
    test.session.append('assistant/message', {
      turn: 1, step: 1,
      message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [], id: MessageId('a1') },
      usage: { inputTokens: 50, outputTokens: 10 },
    }, { surfaceOp: 'append' })
    const result = await run(test)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Tool calls: 1')
    expect(result.text).toContain('  read_file: 1')
    expect(result.text).toContain('50 / 10 / 0 / 0')
  })
})


describe('/stats trailing help request', () => {
  it('answers `/stats help` with the rendered usage text, not a model turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(commandStats)
  const session = ctx.sessions.create(SessionId(`stats-${Math.random()}`))
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
    const execution = await ctx.commands.execute(agent, '/stats help', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('/stats')
    expect(text).toContain('Usage:')
  })
})
