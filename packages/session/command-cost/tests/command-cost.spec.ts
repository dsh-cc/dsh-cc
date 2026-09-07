import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import * as commandCost from '@dsh-cc/command-cost'
import type { ModelPrice } from '@dsh-cc/command-cost/cost'
import { callCost, foldCost, formatCostReport, formatUsd, resolvePrice } from '@dsh-cc/command-cost/cost'

const PRICE: ModelPrice = {
  model: 'deepseek-chat',
  provider: 'deepseek',
  inputPerMTok: 0.27,
  outputPerMTok: 1.10,
  cacheReadPerMTok: 0.07,
  cacheWritePerMTok: 0.07,
}

/** Build a minimal session event for fold tests without touching a live session. */
function ev(type: string, data: unknown, seq: number): SessionEvent {
  return Object.freeze({ seq, time: seq * 10, type, data }) as SessionEvent
}

/** A `request/header` snapshot naming one model route. */
function header(seq: number, provider: string, model: string): SessionEvent {
  return ev('request/header', { header: { config: { provider, model } }, reason: 'initial' }, seq)
}

/** An `assistant/message` carrying the step's usage. */
function usage(seq: number, usage: TokenUsage): SessionEvent {
  return ev('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage }, seq)
}

describe('@dsh-cc/command-cost registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    const plugin = await ctx.plugin(commandCost, { modelTable: [PRICE] })
    const session = ctx.sessions.create(SessionId(`command-cost-${Math.random()}`))
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

    expect(commandCost.name).toBe('command-cost')
    expect(commandCost.inject).toEqual(['commands'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandCost)).toBe(commandCost)
    expect(ctx.commands.find(agent, 'cost')).toBeDefined()

    const execution = await ctx.commands.execute(agent, '/cost', [], new AbortController().signal)
    expect(execution?.result).toEqual({
      kind: 'success',
      text: 'No usage data yet; no model calls have recorded token accounting.',
    })

    await plugin.dispose()
    expect(ctx.commands.find(agent, 'cost')).toBeUndefined()
  })
})

describe('/cost fold', () => {
  it('folds usage per routed model and computes cost against the price table', () => {
    const events = [
      header(1, 'deepseek', 'deepseek-chat'),
      usage(2, { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000 }),
      header(3, 'deepseek', 'deepseek-reasoner'),
      usage(4, { inputTokens: 2_000_000, outputTokens: 200_000 }),
    ]
    const report = foldCost(events, [{ ...PRICE, model: 'deepseek-reasoner' }, { ...PRICE, model: '*' }])
    expect(report.perModel).toHaveLength(2)
    const chat = report.perModel.find(m => m.model === 'deepseek-chat')!
    const reasoner = report.perModel.find(m => m.model === 'deepseek-reasoner')!
    expect(chat).toMatchObject({ messages: 1, inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000, priced: true })
    // chat: (1e6*0.27 + 1e5*1.10 + 5e5*0.07)/1e6
    expect(chat.costUsd).toBeCloseTo((1_000_000 * 0.27 + 100_000 * 1.10 + 500_000 * 0.07) / 1_000_000, 6)
    // reasoner: exact table match (input 2e6*0.27 + output 2e5*1.10)/1e6
    expect(reasoner.costUsd).toBeCloseTo((2_000_000 * 0.27 + 200_000 * 1.10) / 1_000_000, 6)
    expect(report.totalUsd).toBeCloseTo(chat.costUsd + reasoner.costUsd, 6)
  })

  it('accrues multiple steps of one model into a single bucket', () => {
    const events = [
      header(1, 'deepseek', 'deepseek-chat'),
      usage(2, { inputTokens: 100, outputTokens: 50 }),
      usage(3, { inputTokens: 200, outputTokens: 100 }),
    ]
    const report = foldCost(events, [PRICE])
    expect(report.perModel).toHaveLength(1)
    expect(report.perModel[0]).toMatchObject({ messages: 2, inputTokens: 300, outputTokens: 150 })
  })

  it('reports an unpriced model with zero cost and a priced flag off', () => {
    const events = [
      header(1, 'deepseek', 'deepseek-chat'),
      usage(2, { inputTokens: 100, outputTokens: 50 }),
    ]
    const report = foldCost(events, [])
    expect(report.perModel[0]).toMatchObject({ model: 'deepseek-chat', costUsd: 0, priced: false })
  })

  it('ignores steps that never selected a model route', () => {
    const events = [
      usage(1, { inputTokens: 100, outputTokens: 50 }),
    ]
    expect(foldCost(events, [PRICE]).perModel).toEqual([])
  })

  it('returns an empty report for the empty path (no usage events)', () => {
    const events = [header(1, 'deepseek', 'deepseek-chat'), ev('turn/start', { turn: 0 }, 2)]
    const report = foldCost(events, [PRICE])
    expect(report.perModel).toEqual([])
    expect(report.totalUsd).toBe(0)
  })
})

describe('/cost pricing helpers', () => {
  it('resolves exact model+provider, exact model, then the wildcard default', () => {
    const table: ModelPrice[] = [{ ...PRICE, model: 'm1', provider: 'p1' }, { ...PRICE, model: '*' }]
    expect(resolvePrice(table, 'p1', 'm1')).toEqual(table[0])
    expect(resolvePrice(table, 'p2', 'm2')).toEqual(table[1])
    expect(resolvePrice([table[0] as ModelPrice], 'p2', 'm2')).toBeUndefined()
  })
  it('computes per-call cost from the price column', () => {
    const cost = callCost(
      { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 250 },
      { model: 'x', inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.5, cacheWritePerMTok: 0 },
    )
    expect(cost).toBeCloseTo((1000 * 1 + 500 * 2 + 250 * 0.5) / 1_000_000, 6)
  })
  it('formats USD with two fixed decimals', () => {
    expect(formatUsd(1.239)).toBe('$1.24')
    expect(formatUsd(0)).toBe('$0.00')
  })
})

describe('/cost formatting snapshot', () => {
  it('renders an empty report directly', () => {
    expect(formatCostReport({ perModel: [], totalUsd: 0 }))
      .toBe('No usage data yet; no model calls have recorded token accounting.')
  })
  it('renders per-model rows, an unpriced marker, and the total', () => {
    const report = foldCost(
      [
        header(1, 'deepseek', 'deepseek-chat'),
        usage(2, { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000 }),
        header(3, 'deepseek', 'deepseek-reasoner'),
        usage(4, { inputTokens: 2_000_000, outputTokens: 200_000 }),
      ],
      [{ ...PRICE, model: 'deepseek-reasoner' }, { ...PRICE, model: '*' }],
    )
    const text = formatCostReport(report)
    expect(text).toContain('deepseek/deepseek-chat')
    expect(text).toContain('Input: 1000000 (uncached) + 500000 (cache-read) + 0 (cache-write)')
    expect(text).toContain('Cost: $0.42')
    expect(text).toContain('deepseek/deepseek-reasoner')
    expect(text).toContain('Total: 3800000 tokens, $1.18')
  })
})


describe('/cost trailing help request', () => {
  it('answers `/cost help` with the rendered usage text, not a model turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(commandCost, { modelTable: [] })
  const session = ctx.sessions.create(SessionId(`cost-${Math.random()}`))
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
    const execution = await ctx.commands.execute(agent, '/cost help', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('/cost')
    expect(text).toContain('Usage:')
  })
})
