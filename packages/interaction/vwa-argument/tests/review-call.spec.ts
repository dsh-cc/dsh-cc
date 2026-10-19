/**
 * B.4 review-call spec: dynamic timeout formula (B.2.3), class-aware retry
 * loop with backoff (B.2.4), abort-aware backoff, providerRetryAfterMs, and
 * usage-ledger retryOf linkage.
 * @module tests/review-call
 */

import { getEventListeners } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ReviewConfigDriftError, ReviewInvalidError, ReviewTruncatedError,
  type PreparedReviewCall, type ReviewMessages, type ReviewModelAdapter,
} from '../src/review-adapter.ts'
import { BudgetTracker } from '../src/review-tasks.ts'
import { ReviewCaller } from '../src/review-call.ts'
import type { ReviewBudget } from '../src/review-runner.ts'
import type { UsageRow } from '../src/review-run-store.ts'

function budget(over: Partial<ReviewBudget> = {}): ReviewBudget {
  return {
    maxCallsPerRun: 40, maxInputTokensPerRun: 1_000_000, maxOutputTokensPerRun: 1_000_000,
    maxOutputTokensPerCall: 3000, wallMs: 600_000, callTimeoutMs: 1_000, concurrency: 1,
    ...over,
  }
}

/** Adapter stub with a fixed token count and a scripted dispatch sequence. */
function stubAdapter(tokens: number, dispatches: Array<() => Promise<{ raw: string }> | { raw: string }>): ReviewModelAdapter {
  let n = 0
  return {
    async prepareReviewCall() {
      const step = dispatches[Math.min(n, dispatches.length - 1)]!
      n += 1
      return {
        describe: () => ({ modelId: 'm', providerId: 'p', version: 'v', effectiveOptions: {} }),
        dispatch: step,
      } as unknown as PreparedReviewCall
    },
    async countInput() {
      return { tokens, method: 'tokenizer' as const }
    },
    configFingerprint: () => ({}),
  }
}

const MESSAGES: ReviewMessages = [{ role: 'user', content: 'task input' }]
const parseOk = (raw: string) => JSON.parse(raw) as { ok: number }

/** Record every setTimeout delay (timeout timers AND backoff sleeps). */
function trackTimers(): number[] {
  const delays: number[] = []
  const real = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: never, ms?: number, ...a: unknown[]) => {
    delays.push(ms ?? 0)
    return real(fn, ms as never, ...a)
  }) as typeof setTimeout)
  return delays
}

describe('B.2.3 — dynamic timeout formula', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // Base 20s so the 4x ceiling (80s) sits above the base+40s case.
  async function timeoutDelayFor(tokens: number, over: Partial<ReviewBudget> = {}): Promise<number> {
    const delays = trackTimers()
    const b = budget({ callTimeoutMs: 20_000, ...over })
    const caller = new ReviewCaller(
      stubAdapter(tokens, [() => new Promise(() => {})]), // never resolves → deadline fires
      new BudgetTracker(b), b, new AbortController().signal, () => {},
    )
    const pending = caller.call('t1', MESSAGES, {}, parseOk).catch(() => 'timed-out')
    await vi.runAllTimersAsync()
    await pending
    return delays[0]!
  }

  it('0 tokens → base timeout', async () => {
    expect(await timeoutDelayFor(0)).toBe(20_000)
  })

  it('20k tokens → base + 40s', async () => {
    expect(await timeoutDelayFor(20_000)).toBe(60_000)
  })

  it('100k tokens → ceiling 4x base', async () => {
    expect(await timeoutDelayFor(100_000)).toBe(80_000)
  })
})

describe('B.2.4 — class-aware retry loop', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const TOKENS = 100 // timeout timer per attempt = 1000 + 200 = 1200 (≠ any backoff)

  function make(rows: Omit<UsageRow, 'runId'>[], dispatches: Array<() => Promise<{ raw: string }> | { raw: string }>, over: Partial<ReviewBudget> = {}, signal = new AbortController().signal) {
    const b = budget(over)
    return new ReviewCaller(stubAdapter(TOKENS, dispatches), new BudgetTracker(b), b, signal, (row) => rows.push(row))
  }

  it('invalid: 3 attempts total with exponential backoff 1s then 4s; retryAttempts=3', async () => {
    const delays = trackTimers()
    const parse = () => { throw new ReviewInvalidError('bad shape') }
    let caught: unknown
    const pending = make([], [() => ({ raw: '{}' })]).call('t1', MESSAGES, {}, parse).catch((e) => { caught = e })
    await vi.runAllTimersAsync()
    await pending
    expect((caught as { retryAttempts?: number }).retryAttempts).toBe(3)
    // 3 timeout timers (1200 each) + backoffs 1s, 4s.
    expect(delays.filter((d) => d !== 1_200)).toEqual([1_000, 4_000])
  })

  it('transient: 2 attempts total with fixed 5s backoff; retry succeeds', async () => {
    const delays = trackTimers()
    const rows: Omit<UsageRow, 'runId'>[] = []
    const pending = make(rows, [
      () => Promise.reject(new Error('transport boom')),
      () => ({ raw: '{"ok":1}' }),
    ]).call('t1', MESSAGES, {}, parseOk)
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toEqual({ raw: { ok: 1 }, inputTokens: 100, outputTokens: 3000 })
    expect(delays.filter((d) => d !== 1_200)).toEqual([5_000])
    expect(rows.filter((r) => r.kind === 'actual').length).toBeGreaterThanOrEqual(1)
  })

  it('truncation: no retry, retryAttempts=1', async () => {
    const delays = trackTimers()
    let caught: unknown
    const pending = make([], [() => Promise.reject(new ReviewTruncatedError())])
      .call('t1', MESSAGES, {}, parseOk).catch((e) => { caught = e })
    await vi.runAllTimersAsync()
    await pending
    expect(caught).toBeInstanceOf(ReviewTruncatedError)
    expect((caught as { retryAttempts?: number }).retryAttempts).toBe(1)
    expect(delays.filter((d) => d !== 1_200)).toEqual([]) // no backoff
  })

  it('config drift: permanent, no retry', async () => {
    const delays = trackTimers()
    let caught: unknown
    const pending = make([], [() => Promise.reject(new ReviewConfigDriftError())])
      .call('t1', MESSAGES, {}, parseOk).catch((e) => { caught = e })
    await vi.runAllTimersAsync()
    await pending
    expect(caught).toBeInstanceOf(ReviewConfigDriftError)
    expect((caught as { retryAttempts?: number }).retryAttempts).toBe(1)
    expect(delays.filter((d) => d !== 1_200)).toEqual([])
  })

  it('429 with providerRetryAfterMs uses that delay', async () => {
    const delays = trackTimers()
    const e = Object.assign(new Error('rate limited'), {
      detail: { httpStatus: 429, providerCode: 'rate_limited', providerRetryAfterMs: 1_234 },
    })
    const pending = make([], [
      () => Promise.reject(e),
      () => ({ raw: '{"ok":1}' }),
    ]).call('t1', MESSAGES, {}, parseOk)
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toBeTruthy()
    expect(delays.filter((d) => d !== 1_200)).toEqual([1_234])
  })

  it('backoff respects the abort signal', async () => {
    const ac = new AbortController()
    let caught: unknown
    const pending = make([], [() => Promise.reject(new ReviewInvalidError('bad'))], {}, ac.signal)
      .call('t1', MESSAGES, {}, () => { throw new ReviewInvalidError('bad') })
      .catch((e) => { caught = e })
    await vi.advanceTimersByTimeAsync(500) // inside the 1s invalid backoff
    expect(caught).toBeUndefined() // still sleeping, not yet rejected
    ac.abort()
    await pending
    expect(caught).toBeInstanceOf(ReviewInvalidError)
  })

  it('backoff respects the remaining wall: no retry when the wall is exhausted', async () => {
    const delays = trackTimers()
    let caught: unknown
    // Never-resolving dispatch: the deadline (clamped to the 100ms wall) fires and
    // exhausts the wall, so no retry and no backoff sleep.
    const pending = make([], [() => new Promise(() => {})], { wallMs: 100 })
      .call('t1', MESSAGES, {}, parseOk).catch((e) => { caught = e })
    await vi.runAllTimersAsync()
    await pending
    expect(String(caught)).toContain('review call timeout')
    expect((caught as { retryAttempts?: number }).retryAttempts).toBe(1)
    expect(delays.filter((d) => d !== 100)).toEqual([]) // no backoff slept
  })

  it('usage rows: retry rows carry retryOf linking to the original attempt', async () => {
    const rows: Omit<UsageRow, 'runId'>[] = []
    const pending = make(rows, [() => ({ raw: '{}' }), () => ({ raw: '{"ok":1}' })]).call('t1', MESSAGES, {}, (raw) => {
      const v = JSON.parse(raw) as { ok?: number }
      if (!v.ok) throw new ReviewInvalidError('missing ok')
      return v
    })
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toBeTruthy()
    const firstSeq = Math.min(...rows.map((r) => r.seq))
    for (const row of rows) {
      if (row.seq === firstSeq) expect(row.retryOf).toBeUndefined()
      else expect(row.retryOf).toBe(`t1:${firstSeq}`)
    }
  })
})


describe('retry termination diagnostics and cleanup', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each(['local', 'shared'] as const)('%s budget rejection preserves completed attempts', async (kind) => {
    const b = budget({ maxCallsPerRun: kind === 'local' ? 2 : 40 })
    const tracker = new BudgetTracker(b)
    const rows: Omit<UsageRow, 'runId'>[] = []
    const caller = new ReviewCaller(
      stubAdapter(100, [() => ({ raw: '{}' })]), tracker, b,
      new AbortController().signal, (row) => rows.push(row), 48_000,
      kind === 'shared' ? (_tokens, reserve) => tracker.calls < 2 && reserve() : undefined,
    )
    const pending = caller.call('t1', MESSAGES, {}, () => { throw new ReviewInvalidError('bad') })
      .catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    expect(await pending).toMatchObject({ code: 'BUDGET_EXHAUSTED', retryAttempts: 2 })
    expect(rows.filter((row) => row.kind === 'reserved')).toHaveLength(2)
    expect(tracker.calls).toBe(2)
  })

  it('a rejected initial reservation reports zero attempts', async () => {
    const b = budget({ maxCallsPerRun: 0 })
    const caller = new ReviewCaller(stubAdapter(100, [() => ({ raw: '{}' })]),
      new BudgetTracker(b), b, new AbortController().signal, () => {})
    await expect(caller.call('t1', MESSAGES, {}, parseOk))
      .rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED', retryAttempts: 0 })
  })

  it.each(['success', 'exhausted', 'cancelled'] as const)('cleans backoff listeners after %s', async (outcome) => {
    const ac = new AbortController()
    const b = budget()
    const caller = new ReviewCaller(stubAdapter(100, [() => ({ raw: '{}' })]),
      new BudgetTracker(b), b, ac.signal, () => {})
    let parses = 0
    const pending = caller.call('t1', MESSAGES, {}, () => {
      if (++parses === 2 && outcome === 'success') return { ok: 1 }
      throw new ReviewInvalidError('bad')
    }).catch((error: unknown) => error)
    if (outcome === 'cancelled') {
      await vi.advanceTimersByTimeAsync(500)
      expect(getEventListeners(ac.signal, 'abort')).toHaveLength(1)
      ac.abort()
    }
    await vi.runAllTimersAsync()
    await pending
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
