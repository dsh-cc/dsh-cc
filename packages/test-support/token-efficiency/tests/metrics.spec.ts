import { describe, expect, it } from 'vitest'
import type { SessionLogEvent } from '@dsh-cc/cache-trajectory'
import type { ModelPrice } from '@dsh-cc/command-cost'
import {
  MetricDeviationError,
  adaptForFoldCost,
  foldMetricVector,
  usageCoverage,
} from '../src/metrics'

const TABLE: ModelPrice[] = [
  {
    model: 'dsv3',
    provider: 'deepseek',
    inputPerMTok: 0.27,
    outputPerMTok: 1.1,
    cacheReadPerMTok: 0.07,
    cacheWritePerMTok: 0.27,
  },
]

function header(provider = 'deepseek', model = 'dsv3'): SessionLogEvent {
  return { type: 'request/header', data: { header: { config: { provider, model } } } }
}

function assistant(
  usage?: Record<string, number>,
  extra?: Record<string, unknown>,
): SessionLogEvent {
  return {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: {}, ...extra, ...(usage !== undefined ? { usage } : {}) },
  }
}

describe('foldMetricVector', () => {
  it('folds a synthetic stream into the exact vector incl. cache splits', () => {
    const vector = foldMetricVector(
      [
        header(),
        assistant({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 }),
        assistant({ inputTokens: 30, outputTokens: 5 }),
      ],
      { task: 't' },
    )
    expect(vector).toEqual({
      task: 't',
      tokens: { input: 130, output: 25, cacheRead: 50, cacheWrite: 10, total: 215 },
      counters: {},
    })
    expect('capability' in vector).toBe(false)
    expect('costUsd' in vector).toBe(false)
  })

  it('treats absent cache fields as 0', () => {
    const vector = foldMetricVector([header(), assistant({ inputTokens: 7, outputTokens: 3 })], { task: 't' })
    expect(vector.tokens).toEqual({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10 })
  })

  it('excludes usage-less assistant/message events from tokens; coverage surfaces it', () => {
    const events = [header(), assistant(), assistant({ inputTokens: 1, outputTokens: 1 })]
    const vector = foldMetricVector(events, { task: 't' })
    expect(vector.tokens.total).toBe(2)
    expect(usageCoverage(events)).toEqual({ assistantMessages: 2, withUsage: 1 })
  })

  it('ignores unknown non-usage event types', () => {
    const vector = foldMetricVector(
      [header(), { type: 'tool/call', data: { turn: 1 } }, assistant({ inputTokens: 2, outputTokens: 0 })],
      { task: 't' },
    )
    expect(vector.tokens.total).toBe(2)
  })

  it('throws MetricDeviationError on a deviant usage-bearing shape', () => {
    const badUsage = { inputTokens: 'many', outputTokens: 1 }
    expect(() =>
      foldMetricVector([header(), assistant(badUsage as unknown as Record<string, number>)], { task: 't' }),
    ).toThrow(MetricDeviationError)
    expect(() =>
      foldMetricVector([{ type: 'tool/result', data: { inputTokens: 5 } } as unknown as SessionLogEvent], { task: 't' }),
    ).toThrow(MetricDeviationError)
  })

  it('throws when request/header lacks provider or model', () => {
    const badHeader = { type: 'request/header', data: { header: { config: { model: 'dsv3' } } } } as unknown as SessionLogEvent
    expect(() => foldMetricVector([badHeader], { task: 't' })).toThrow(MetricDeviationError)
    const noConfig = { type: 'request/header', data: {} } as unknown as SessionLogEvent
    expect(() => foldMetricVector([noConfig], { task: 't' })).toThrow(MetricDeviationError)
  })

  it('costUsd present with priceTable and matches hand-computed value incl. cache rates', () => {
    // (1000*0.27 + 2000*1.1 + 500*0.07 + 100*0.27) / 1e6 = 2532/1e6
    const vector = foldMetricVector(
      [
        header(),
        assistant({ inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 500, cacheWriteTokens: 100 }),
      ],
      { task: 't', priceTable: TABLE },
    )
    expect(vector.costUsd).toBe(0.002532)
  })

  it('costUsd absent without priceTable', () => {
    const vector = foldMetricVector([header(), assistant({ inputTokens: 1, outputTokens: 1 })], { task: 't' })
    expect('costUsd' in vector).toBe(false)
  })

  it('capability is absent in every replay-style call', () => {
    for (const opts of [{ task: 't' }, { task: 't', priceTable: TABLE }]) {
      const vector = foldMetricVector([header(), assistant({ inputTokens: 1, outputTokens: 1 })], opts)
      expect('capability' in vector).toBe(false)
    }
  })

  it('attributes multi-model usage via request/header switches and sums both buckets', () => {
    const vector = foldMetricVector(
      [
        header('deepseek', 'dsv3'),
        assistant({ inputTokens: 10, outputTokens: 1 }),
        header('openai', 'gptx'),
        assistant({ inputTokens: 20, outputTokens: 2 }),
      ],
      { task: 't', priceTable: [...TABLE, { model: 'gptx', provider: 'openai', inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0, cacheWritePerMTok: 0 }] },
    )
    // 10*0.27+1*1.1 = 3.8 USD/MTok-scale => (2.7+1.1)/1e6; gptx: (20*1+2*2)/1e6 = 24/1e6
    expect(vector.tokens).toEqual({ input: 30, output: 3, cacheRead: 0, cacheWrite: 0, total: 33 })
    expect(vector.costUsd).toBeCloseTo(3.8e-6 + 24e-6, 12)
  })
})

describe('adaptForFoldCost', () => {
  it('keeps header and assistant events, passes unknown types through, drops nothing silently for usage', () => {
    const events = [header(), { type: 'tool/call', data: {} }, assistant({ inputTokens: 1, outputTokens: 1 })]
    const adapted = adaptForFoldCost(events)
    expect(adapted).toHaveLength(3)
    expect(adapted.map(e => e.type)).toEqual(['request/header', 'tool/call', 'assistant/message'])
  })

  it('throws with type and index for deviant usage-bearing events', () => {
    const events = [header(), assistant(), assistant({ inputTokens: null, outputTokens: 1 })]
    expect(() => adaptForFoldCost(events)).toThrow(/assistant\/message.*index 2/)
  })
})
