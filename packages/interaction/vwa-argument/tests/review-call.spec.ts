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
import { AuditInvalidError, parseExtractResponse } from '../src/audit-input.ts'
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

  it('repairs audit extraction JSON with the invalid-response retry policy', async () => {
    const delays = trackTimers()
    const adapter = stubAdapter(TOKENS, [
      () => ({ raw: '{' }),
      () => ({ raw: '{' }),
      () => ({ raw: '{"items":[]}' }),
    ])
    const prepare = vi.spyOn(adapter, 'prepareReviewCall')
    const b = budget()
    const caller = new ReviewCaller(adapter, new BudgetTracker(b), b,
      new AbortController().signal, () => {})
    const pending = caller.call('extract', MESSAGES, {}, parseExtractResponse)
      .catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    expect(await pending).toMatchObject({ raw: { items: [] } })
    expect(delays.filter((d) => d !== 1_200)).toEqual([1_000, 4_000])
    expect(prepare).toHaveBeenCalledTimes(3)
    for (const [request] of prepare.mock.calls.slice(1)) {
      expect(request.messages.at(-1)?.content).toContain('previous response was invalid')
      expect(request.messages.at(-1)?.content).toContain('extract response is not valid JSON')
    }
  })

  it('reports three attempts when audit extraction JSON remains invalid', async () => {
    const pending = make([], [() => ({ raw: '{' })])
      .call('extract', MESSAGES, {}, parseExtractResponse).catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    const error = await pending
    expect(error).toBeInstanceOf(AuditInvalidError)
    expect(error).toMatchObject({ code: 'REVIEW_INVALID', retryAttempts: 3 })
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

  it('preserves the class and response tail of a frozen validation failure', async () => {
    const failure = new ReviewInvalidError('invalid frozen response')
    failure.rawResponse = '{'
    Object.freeze(failure)
    const b = budget()
    const caller = new ReviewCaller(stubAdapter(100, [() => ({ raw: '{' })]),
      new BudgetTracker(b), b, new AbortController().signal, () => {})
    const pending = caller.call('t1', MESSAGES, {}, () => { throw failure })
      .catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    const error = await pending
    expect(error).toBeInstanceOf(ReviewInvalidError)
    expect(error).toMatchObject({
      code: 'REVIEW_INVALID', message: 'invalid frozen response', rawResponse: '{', retryAttempts: 3,
    })
  })

  it.each([0, 2])('preserves %i completed attempts when input counting fails', async (attempts) => {
    const b = budget()
    const tracker = new BudgetTracker(b)
    const rows: Omit<UsageRow, 'runId'>[] = []
    const adapter = stubAdapter(100, [() => ({ raw: '{}' })])
    const count = adapter.countInput.bind(adapter)
    const failure = new Error('tokenizer unavailable')
    adapter.countInput = vi.fn(async (messages) => {
      if (tracker.calls === attempts) throw failure
      return count(messages)
    })
    const prepare = vi.spyOn(adapter, 'prepareReviewCall')
    const pending = new ReviewCaller(adapter, tracker, b, new AbortController().signal,
      (row) => rows.push(row)).call('t1', MESSAGES, {}, () => {
        throw new ReviewInvalidError('bad shape')
      }).catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    const error = await pending
    expect(error).toBe(failure)
    expect(error).toMatchObject({ retryAttempts: attempts })
    expect(prepare).toHaveBeenCalledTimes(attempts)
    expect(adapter.countInput).toHaveBeenCalledTimes(attempts + 1)
    expect(rows.filter((row) => row.kind === 'reserved')).toHaveLength(attempts)
    expect(rows).toHaveLength(attempts * 2)
    expect(tracker.calls).toBe(attempts)
  })

  it.each(['local', 'shared'] as const)('settles completed usage before backoff releases the %s budget to a peer', async (kind) => {
    const b = budget({ maxOutputTokensPerRun: 3010 })
    const tracker = new BudgetTracker(b)
    const ledger = new Map<string, number>()
    const rows: Omit<UsageRow, 'runId'>[] = []
    const usage = (row: Omit<UsageRow, 'runId'>) => {
      rows.push(row)
      ledger.set(`${row.taskId}:${row.seq}`, row.outputTokens)
    }
    const reserveShared = (_tokens: number, reserve: () => boolean) =>
      [...ledger.values()].reduce((sum, tokens) => sum + tokens, 0) + b.maxOutputTokensPerCall <= b.maxOutputTokensPerRun && reserve()
    const adapter = stubAdapter(100, [() => ({ raw: '{}', outputTokens: 10 })])
    const first = new ReviewCaller(adapter, tracker, b, new AbortController().signal, usage,
      48_000, kind === 'shared' ? reserveShared : undefined)
    let parses = 0
    const pending = first.call('first', MESSAGES, {}, () => {
      if (++parses === 1) throw new ReviewInvalidError('bad shape')
      return { ok: 1 }
    }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0) // first dispatch completed, inside its 1s backoff
    const settledBeforeBackoff = rows.some((row) => row.taskId === 'first' && row.kind === 'actual')
    const peer = new ReviewCaller(adapter, kind === 'local' ? tracker : new BudgetTracker(b), b,
      new AbortController().signal, usage, 48_000, kind === 'shared' ? reserveShared : undefined)
    const peerResult = await peer.call('peer', MESSAGES, {}, JSON.parse).catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    await pending
    expect(settledBeforeBackoff).toBe(true)
    expect(peerResult).toMatchObject({ raw: {}, outputTokens: 10 })
  })

  it('reports zero attempts when context is refused before dispatch', async () => {
    const b = budget()
    const prepare = vi.fn()
    const adapter = { ...stubAdapter(100, []), prepareReviewCall: prepare }
    const caller = new ReviewCaller(adapter, new BudgetTracker(b), b,
      new AbortController().signal, () => {}, 1)
    await expect(caller.call('t1', MESSAGES, {}, parseOk))
      .rejects.toMatchObject({ code: 'CONTEXT_TOO_LARGE', retryAttempts: 0 })
    expect(prepare).not.toHaveBeenCalled()
  })

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
