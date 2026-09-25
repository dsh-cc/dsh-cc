/**
 * Bounded HTTP 429 retry in the System One client: honors Retry-After
 * (delay-seconds and IMF-fixdate only, clamped), falls back to jittered
 * exponential backoff, caps attempts and total elapsed time, and never sleeps
 * into the per-call timeout — after which the last
 * 429 degrades exactly as before (`failure: 'error'`, `http 429: …`). Sleep,
 * clock and jitter are injected, so nothing here waits for real.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  SYSTEMONE_429_MAX_RETRIES,
  SYSTEMONE_429_RETRY_AFTER_CAP_MS,
  SYSTEMONE_429_RETRY_BUDGET_MS,
  parseRetryAfterMs,
  systemoneDecide,
} from '../src/systemone-client.ts'
import type { SystemOneQuestion } from '../src/systemone-client.ts'
import { classifyViaSystemOne, prepareSystemOneInput } from '../src/gauge-adapter.ts'

const OK_BODY = '{"model":"laya-rl-agent","answers":{"verdict":{"type":"choice","choice":"allow","probabilities":{"allow":0.9,"ask":0.05,"deny":0.05},"confidence":0.8}},"usage":{"input_tokens":83,"output_tokens":0}}'
const RATE_LIMITED = '{"error":{"type":"rate_limit_error","message":"slow down"}}'
const QUESTIONS: Record<string, SystemOneQuestion> = { verdict: { type: 'choice', instructions: 'Judge.', criteria: { allow: 'a', ask: 'b', deny: 'c' } } }

/** Scripted fetch: each entry is one response (status + optional Retry-After). */
function scriptedFetch(script: Array<{ status: number; retryAfter?: string }>) {
  const queue = [...script]
  return vi.fn(async () => {
    const next = queue.shift() ?? { status: 200 }
    const headers = next.retryAfter === undefined ? undefined : { 'retry-after': next.retryAfter }
    return new Response(next.status === 200 ? OK_BODY : RATE_LIMITED, { status: next.status, ...(headers ? { headers } : {}) })
  })
}

/** Fake clock whose sleep advances time instantly and records each wait. */
function fakeClock(start = Date.parse('2026-09-26T00:00:00Z')) {
  let now = start
  const waits: number[] = []
  return {
    waits,
    clock: {
      now: () => now,
      sleep: async (ms: number) => { waits.push(ms); now += ms },
      random: () => 0,
    },
  }
}

function decide(fetchImpl: ReturnType<typeof scriptedFetch>, clock: ReturnType<typeof fakeClock>['clock'], signal?: AbortSignal, timeoutMs = 60_000) {
  return systemoneDecide({
    baseURL: 'http://gw', model: 'llmbox_systemone/laya', state: {}, questions: QUESTIONS, timeoutMs,
    fetchImpl: fetchImpl as unknown as typeof fetch, clock, ...(signal ? { signal } : {}),
  })
}

describe('systemoneDecide 429 retry', () => {
  it('429 with Retry-After (seconds) waits that long, retries, and succeeds', async () => {
    const fetchImpl = scriptedFetch([{ status: 429, retryAfter: '1' }, { status: 200 }])
    const { clock, waits } = fakeClock()
    const result = await decide(fetchImpl, clock)
    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(waits).toEqual([1000])
  })

  it('429 with Retry-After (HTTP-date) waits until that date, retries, and succeeds', async () => {
    const { clock, waits } = fakeClock()
    const at = new Date(clock.now() + 1500).toUTCString() // second resolution → 1000..1500ms
    const fetchImpl = scriptedFetch([{ status: 429, retryAfter: at }, { status: 200 }])
    const result = await decide(fetchImpl, clock)
    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(waits).toHaveLength(1)
    expect(waits[0]).toBe(Math.max(0, Date.parse(at) - Date.parse('2026-09-26T00:00:00Z')))
  })

  it('429 without Retry-After backs off exponentially (with jitter) and succeeds', async () => {
    const fetchImpl = scriptedFetch([{ status: 429 }, { status: 429 }, { status: 200 }])
    const { clock, waits } = fakeClock()
    const result = await decide(fetchImpl, clock)
    expect(result.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    // random() = 0 → the lower edge of each equal-jitter window: 100ms, 200ms.
    expect(waits).toEqual([100, 200])
  })

  it('a huge Retry-After is clamped to the cap', async () => {
    const fetchImpl = scriptedFetch([{ status: 429, retryAfter: '3600' }, { status: 200 }])
    const { clock, waits } = fakeClock()
    const result = await decide(fetchImpl, clock)
    expect(result.ok).toBe(true)
    expect(waits).toEqual([SYSTEMONE_429_RETRY_AFTER_CAP_MS])
  })

  it('over the attempt cap: the last 429 degrades exactly as before (failure error, http 429 body)', async () => {
    const fetchImpl = scriptedFetch(Array.from({ length: 10 }, () => ({ status: 429 })))
    const { clock } = fakeClock()
    const result = await decide(fetchImpl, clock)
    expect(fetchImpl).toHaveBeenCalledTimes(1 + SYSTEMONE_429_MAX_RETRIES)
    expect(result).toEqual({ ok: false, failure: 'error', reason: `http 429: ${RATE_LIMITED}` })
  })

  it('over the time budget: a retry whose wait would overrun the budget is not attempted', async () => {
    const fetchImpl = scriptedFetch([{ status: 429, retryAfter: '2' }, { status: 429, retryAfter: '2' }, { status: 200 }])
    const { clock, waits } = fakeClock()
    const result = await decide(fetchImpl, clock)
    // 0 + 2000 fits the 3000ms budget; 2000 + 2000 does not → degrade after 2 requests.
    expect(waits).toEqual([2000])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(SYSTEMONE_429_RETRY_BUDGET_MS)
    expect(result).toEqual({ ok: false, failure: 'error', reason: `http 429: ${RATE_LIMITED}` })
  })

  it('a caller abort during the backoff wait maps to cancelled (no further request)', async () => {
    const fetchImpl = scriptedFetch([{ status: 429, retryAfter: '1' }, { status: 200 }])
    const controller = new AbortController()
    const { clock } = fakeClock()
    const result = await decide(fetchImpl, { ...clock, sleep: async () => { controller.abort() } }, controller.signal)
    expect(result).toEqual({ ok: false, failure: 'cancelled', reason: 'caller aborted the request' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('non-429 errors are still not retried', async () => {
    const fetchImpl = scriptedFetch([{ status: 400 }, { status: 200 }])
    const { clock, waits } = fakeClock()
    const result = await decide(fetchImpl, clock)
    expect(result.ok).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(waits).toEqual([])
  })

  it('a wait that would reach the per-call timeout is not attempted: timeoutMs 1000 + Retry-After 2 returns the http 429 error at once', async () => {
    const fetchImpl = scriptedFetch([{ status: 429, retryAfter: '2' }, { status: 200 }])
    const { clock, waits } = fakeClock()
    const result = await decide(fetchImpl, clock, undefined, 1000)
    expect(result).toEqual({ ok: false, failure: 'error', reason: `http 429: ${RATE_LIMITED}` })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(waits).toEqual([])
  })

  it('a wait that fits inside the per-call timeout is still attempted', async () => {
    const fetchImpl = scriptedFetch([{ status: 429, retryAfter: '1' }, { status: 200 }])
    const { clock, waits } = fakeClock()
    const result = await decide(fetchImpl, clock, undefined, 1500)
    expect(result.ok).toBe(true)
    expect(waits).toEqual([1000])
  })

  it.each(['-1', '1.5', '+3', 'soon', '2026-09-26T00:00:03Z'])('an invalid Retry-After (%j) falls back to backoff instead of an immediate retry', async (retryAfter) => {
    const fetchImpl = scriptedFetch([{ status: 429, retryAfter }, { status: 200 }])
    const { clock, waits } = fakeClock()
    const result = await decide(fetchImpl, clock)
    expect(result.ok).toBe(true)
    // random() = 0 → lower edge of the first backoff window, never 0ms.
    expect(waits).toEqual([100])
  })

  it('parseRetryAfterMs accepts only delay-seconds and IMF-fixdate', () => {
    const now = Date.parse('2026-09-26T00:00:00Z')
    // Valid forms.
    expect(parseRetryAfterMs('2', now)).toBe(2000)
    expect(parseRetryAfterMs('0', now)).toBe(0)
    expect(parseRetryAfterMs(' 2 ', now)).toBe(2000)
    expect(parseRetryAfterMs('Sat, 26 Sep 2026 00:00:03 GMT', now)).toBe(3000)
    expect(parseRetryAfterMs('Fri, 25 Sep 2026 00:00:00 GMT', now)).toBe(0)
    // Shapes V8's Date.parse would happily read as dates in 2001 (→ 0ms waits).
    expect(Number.isNaN(Date.parse('-1'))).toBe(false)
    expect(parseRetryAfterMs('-1', now)).toBeUndefined()
    expect(parseRetryAfterMs('1.5', now)).toBeUndefined()
    expect(parseRetryAfterMs('+3', now)).toBeUndefined()
    // Other date spellings and garbage.
    expect(parseRetryAfterMs('2026-09-26T00:00:03Z', now)).toBeUndefined()
    expect(parseRetryAfterMs('Saturday, 26-Sep-26 00:00:03 GMT', now)).toBeUndefined()
    expect(parseRetryAfterMs('soon', now)).toBeUndefined()
    expect(parseRetryAfterMs('', now)).toBeUndefined()
    expect(parseRetryAfterMs(null, now)).toBeUndefined()
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined()
  })
})

describe('gauge adapter over the retrying client (real timers)', () => {
  const SLOTS = { hardDeny: [], softDeny: [], allowExceptions: [], environment: [] }
  const prepared = () => prepareSystemOneInput({ name: 'Bash', arguments: { command: 'git status' } }, SLOTS)

  it('a transient 429 (Retry-After: 0) is absorbed and the verdict is allow', async () => {
    const fetchImpl = scriptedFetch([{ status: 429, retryAfter: '0' }, { status: 200 }])
    const verdict = await classifyViaSystemOne(prepared(), { baseURL: 'http://gw', model: 'llmbox_systemone/laya' }, { timeoutMs: 5000, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(verdict.verdict).toBe('allow')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('a persistent 429 still degrades to the existing ask + failure error path', async () => {
    const fetchImpl = scriptedFetch(Array.from({ length: 10 }, () => ({ status: 429, retryAfter: '0' })))
    const verdict = await classifyViaSystemOne(prepared(), { baseURL: 'http://gw', model: 'llmbox_systemone/laya' }, { timeoutMs: 5000, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(verdict).toEqual({ verdict: 'ask', reason: `http 429: ${RATE_LIMITED}`, failure: 'error' })
    expect(fetchImpl).toHaveBeenCalledTimes(1 + SYSTEMONE_429_MAX_RETRIES)
  })
})
