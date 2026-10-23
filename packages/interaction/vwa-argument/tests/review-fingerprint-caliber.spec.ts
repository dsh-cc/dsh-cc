/**
 * Fix 5 (reviewer config identity) + Fix 6 (input reservation caliber) pins.
 * - F5.1: budget keys leave configFingerprint; drift check stays full-config.
 * - F5.5: config-shape tripwire against the closed harness LlmCallConfig.
 * - F6.1: bytes/3-estimate fallback; F6.2: tokenizer label is not identity.
 * - F6.3: reservation semantics + failure-path recording pins.
 * @module tests/review-fingerprint-caliber
 */

import { describe, expect, it } from 'vitest'
import { createReviewAdapter, ReviewConfigDriftError } from '../src/review-adapter.ts'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { BudgetTracker } from '../src/review-tasks.ts'
import { ReviewRunStore } from '../src/review-run-store.ts'
import type { ReviewBudget } from '../src/review-budget.ts'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROUTE = { provider: 'fake', model: 'fake-model' }
const SIGNAL = new AbortController().signal
const MESSAGES = [
  { role: 'system' as const, content: 'sys' },
  { role: 'user' as const, content: 'usr' },
]

/** prepareCall fake that echoes {...config, temperature} like the real client. */
function echoingLlm(mutate?: (config: Record<string, unknown>) => Record<string, unknown>) {
  return {
    async prepareCall(config: Record<string, unknown>) {
      const effective = { ...config, temperature: 0.2, ...(mutate?.(config) ?? {}) }
      return {
        config: effective,
        stream: async function* () {
          yield {
            type: 'finish',
            reason: { kind: 'error' as const, failure: { message: 'unused' } },
          }
        },
      }
    },
  }
}

describe('Fix 5 — configFingerprint excludes budget facts', () => {
  it('two adapters initialized at 12k and 16k produce the same fingerprint (with different maxTokens prepared)', async () => {
    const a = createReviewAdapter({ llm: echoingLlm(), route: ROUTE })
    const b = createReviewAdapter({ llm: echoingLlm(), route: ROUTE })
    await a.initialize(12_000, SIGNAL)
    await b.initialize(16_000, SIGNAL)
    // The strip is what equalizes them: the prepared configs really differ.
    const pa = await a.prepareReviewCall({ ...base(), maxOutputTokens: 12_000 })
    const pb = await b.prepareReviewCall({ ...base(), maxOutputTokens: 16_000 })
    expect(pa.describe().effectiveOptions.maxTokens).toBe(12_000)
    expect(pb.describe().effectiveOptions.maxTokens).toBe(16_000)
    expect(a.configFingerprint()).toEqual(b.configFingerprint())
  })

  it('drift guard still compares the FULL config including maxTokens', async () => {
    const adapter = createReviewAdapter({ llm: echoingLlm(), route: ROUTE })
    await adapter.initialize(12_000, SIGNAL)
    await adapter.prepareReviewCall({ ...base(), maxOutputTokens: 12_000 })
    await expect(
      adapter.prepareReviewCall({ ...base(), maxOutputTokens: 16_000 }),
    ).rejects.toBeInstanceOf(ReviewConfigDriftError)
  })

  it('kept keys still invalidate: temperature differs → different fingerprint; maxTokens differs → same', async () => {
    const hot = createReviewAdapter({ llm: echoingLlm(), route: ROUTE })
    const cold = createReviewAdapter({
      llm: echoingLlm(() => ({ temperature: 0.7 })),
      route: ROUTE,
    })
    await hot.initialize(12_000, SIGNAL)
    await cold.initialize(12_000, SIGNAL)
    expect(hot.configFingerprint()).not.toEqual(cold.configFingerprint())

    const small = createReviewAdapter({ llm: echoingLlm(), route: ROUTE })
    const large = createReviewAdapter({ llm: echoingLlm(), route: ROUTE })
    await small.initialize(12_000, SIGNAL)
    await large.initialize(16_000, SIGNAL)
    expect(small.configFingerprint()).toEqual(large.configFingerprint())
  })

  it('config-shape tripwire: effectiveConfig keys ⊆ the closed LlmCallConfig set', async () => {
    const adapter = createReviewAdapter({ llm: echoingLlm(), route: ROUTE })
    await adapter.initialize(12_000, SIGNAL)
    const fp = adapter.configFingerprint() as { effectiveConfig: Record<string, unknown> }
    const allowed = new Set(['provider', 'model', 'reasoningEffort', 'temperature', 'maxTokens', 'stop'])
    const unexpected = Object.keys(fp.effectiveConfig).filter((k) => !allowed.has(k))
    // A future harness key must fail here loudly and be classified (F5 §4.5).
    expect(unexpected).toEqual([])
  })
})

describe('Fix 5 review — config shape verified against the real config path', () => {
  /**
   * Compile-time pin against the harness type (dsh 0.2.0-rc.2, LlmCallConfig is
   * the closed six-key shape). A future harness field that becomes REQUIRED
   * breaks this `satisfies` and forces classification (budget → deny, semantic
   * → keep) instead of a silent identity change.
   */
  const CLOSED_HARNESS_SHAPE = {
    provider: 'fake',
    model: 'fake-model',
    reasoningEffort: 'low',
    temperature: 0.2,
    maxTokens: 1_000,
    stop: ['END'],
  } satisfies LlmCallConfig

  it('the raw prepared config carries the closed harness field set', async () => {
    const adapter = createReviewAdapter({
      // Echo the full closed shape the way a real harness resolve does.
      llm: {
        async prepareCall() {
          return { config: { ...CLOSED_HARNESS_SHAPE }, stream: async function* () {} }
        },
      },
      route: ROUTE,
    })
    await adapter.initialize(1_000, SIGNAL)
    const fp = adapter.configFingerprint() as { effectiveConfig: Record<string, unknown> }
    // The RAW config (post-prepareCall) has every closed-shape key…
    expect(Object.keys(CLOSED_HARNESS_SHAPE).sort()).toEqual(
      ['maxTokens', 'model', 'provider', 'reasoningEffort', 'stop', 'temperature'],
    )
    // …and the fingerprint keeps all of them EXCEPT the budget key.
    expect(Object.keys(fp.effectiveConfig).sort()).toEqual(
      ['model', 'provider', 'reasoningEffort', 'stop', 'temperature'],
    )
    expect(fp.effectiveConfig.maxTokens).toBeUndefined()
    // The semantic values survive verbatim (no accidental reshaping).
    expect(fp.effectiveConfig).toMatchObject({
      provider: 'fake',
      model: 'fake-model',
      reasoningEffort: 'low',
      temperature: 0.2,
      stop: ['END'],
    })
  })

  it('an UNKNOWN future config field enters the fingerprint (denylist fails toward re-invalidation)', async () => {
    // The strip is a denylist: any key the harness adds is hashed, so a future
    // semantic key keeps invalidating records (safe direction) instead of being
    // silently dropped by an allowlist (stale reuse).
    const withFuture = createReviewAdapter({
      llm: echoingLlm(() => ({ futureBudgetKnob: 5 })),
      route: ROUTE,
    })
    const withoutFuture = createReviewAdapter({ llm: echoingLlm(), route: ROUTE })
    await withFuture.initialize(12_000, SIGNAL)
    await withoutFuture.initialize(12_000, SIGNAL)
    const fp = withFuture.configFingerprint() as { effectiveConfig: Record<string, unknown> }
    expect(fp.effectiveConfig.futureBudgetKnob).toBe(5)
    expect(withFuture.configFingerprint()).not.toEqual(withoutFuture.configFingerprint())
  })
})

describe('Fix 6 — countInput caliber and identity neutrality', () => {
  it('400-byte ASCII → 134; 300-byte CJK (100 chars × 3 bytes) → 100', async () => {
    const adapter = createReviewAdapter({ llm: echoingLlm(), route: ROUTE })
    const ascii = await adapter.countInput([{ role: 'user', content: 'a'.repeat(400) }])
    expect(ascii).toEqual({ tokens: 134, method: 'bytes/3-estimate' })
    const cjk = await adapter.countInput([{ role: 'user', content: '齉'.repeat(100) }])
    expect(cjk).toEqual({ tokens: 100, method: 'bytes/3-estimate' })
  })

  it('identity neutrality: a countTokens callback changes no fingerprint', async () => {
    const withMeter = createReviewAdapter({ llm: echoingLlm(), route: ROUTE, countTokens: async () => 7 })
    const withoutMeter = createReviewAdapter({ llm: echoingLlm(), route: ROUTE })
    expect(withMeter.configFingerprint()).toEqual(withoutMeter.configFingerprint())
  })
})

describe('Fix 6 — reservation semantics', () => {
  const budget: ReviewBudget = {
    maxCallsPerRun: 8,
    maxInputTokensPerRun: 160_000,
    maxOutputTokensPerRun: 300_000,
    maxOutputTokensPerCall: 16_000,
    wallMs: 600_000,
    callTimeoutMs: 30_000,
    concurrency: 2,
  }

  it('a 209,175-byte envelope reserves 69,725 and a second call fits 160,000; settle nets actuals', async () => {
    const adapter = createReviewAdapter({ llm: echoingLlm(), route: ROUTE })
    const counted = await adapter.countInput([{ role: 'user', content: 'x'.repeat(209_175) }])
    expect(counted.tokens).toBe(69_725)
    const tracker = new BudgetTracker(budget)
    expect(tracker.reserve(counted.tokens)).toBe(true) // pre-fix: 209,175 refused? no — but two calls would
    expect(tracker.reserve(69_725)).toBe(true) // 139,450 ≤ 160,000 (pre-fix second call refused)
    tracker.settle(69_725, { inputTokens: 32_000, outputTokens: 4_000 })
    expect(tracker.inputTokens).toBe(69_725 + 32_000)
    expect(tracker.outputTokens).toBe(16_000 + 4_000)
  })

  it('failure-path pin: an error row carries the estimate and loadRequest reports it', () => {
    const root = mkdtempSync(join(tmpdir(), 'vwa-fix6-'))
    const store = new ReviewRunStore(root, 'prj_fix6')
    store.initRun('run_fix6')
    store.writeRequest('run_fix6', {
      schemaVersion: 1,
      requestId: 'req_fix6',
      runId: 'run_fix6',
      stage: 'claims',
      targetClaimIds: [],
      status: 'running',
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      startedAt: '',
    })
    store.appendUsage('run_fix6', {
      runId: 'run_fix6',
      taskId: 'task_one',
      seq: 1,
      kind: 'error',
      inputTokens: 69_725,
      outputTokens: 16_000,
      method: 'bytes/3-estimate',
    })
    const loaded = store.loadRequest('run_fix6')
    expect(loaded).toMatchObject({ status: 'incomplete', inputTokens: 69_725 })
  })
})

function base() {
  return {
    messages: MESSAGES,
    responseSchema: {},
    signal: SIGNAL,
  }
}
