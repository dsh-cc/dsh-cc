/**
 * Native System One transport client (design doc §4.4): POSTs
 * `{model, state, questions}` to `{baseURL}/v1/systemone` and maps the wire
 * response into domain types. Wire facts pinned by the Day-0 probe
 * (2026-09-24, see .impl/2026-09-25-gauge-system-one-probe-evidence.md):
 * response envelope `{model, answers{...}, usage{input_tokens, output_tokens}}`,
 * errors are HTTP 400 with `{"error":{"type":"invalid_request_error","message":…}}`,
 * and the gateway silently truncates oversized state (visible via
 * `usage.input_tokens` pinning at the checkpoint window — handled by the
 * adapter's truncation sentinel, not here).
 *
 * HTTP 429 (rate limited) is retried a bounded number of times inside the
 * same per-call timeout: honor `Retry-After` (delay-seconds or IMF-fixdate,
 * clamped), otherwise exponential backoff with jitter. Attempts AND total
 * elapsed time are capped so a permission decision is never stalled for long;
 * a wait that would reach the per-call `timeoutMs` is not attempted either.
 * Once the budget is spent the last 429 falls through to the ordinary
 * `failure: 'error'` degradation, exactly as before retries existed.
 * `opts.maxRetries` may narrow the attempt cap (0..2, `0` means a single
 * attempt); omitting it keeps the legacy `SYSTEMONE_429_MAX_RETRIES`.
 *
 * The decision runner brackets every wire attempt with an optional
 * `attemptObserver`: `beforeDispatch` fires immediately before the fetch (the
 * runner reserves that attempt's quota there and may veto the dispatch), and
 * `afterDispatch` fires exactly once for every attempt that reached fetch —
 * after the body is read and before answer validation, non-ok HTTP statuses
 * and envelopes that later fail validation included — carrying the raw usage
 * read leniently from the body (no usage when the body carries none). Without
 * an observer the call behaves exactly as before.
 *
 * Every call validates strictly on both sides (design doc §"Validation rules"):
 * the request is pre-checked before any network work — an invalid request sends
 * nothing — and only a fully valid, request-matched envelope returns `ok: true`.
 * Any contract violation is `failure: 'malformed'` with a fixed
 * `systemone validation: <code>` reason, and is never retried.
 *
 * Never throws: every failure mode maps to a tagged `SystemOneResult`.
 *
 * @module @dsh-cc/systemone/client
 */

import { validateSystemOneRequest, validateSystemOneResponse } from './validation.ts'

/**
 * Maximum 429 retries after the first attempt (so at most 3 requests). Kept
 * small: the caller is a permission decision on the tool-call hot path.
 */
export const SYSTEMONE_429_MAX_RETRIES = 2

/**
 * Total wall-clock budget (ms, measured from the first request) within which
 * a 429 retry may still be scheduled. A retry whose wait would end past this
 * budget is not attempted; the call degrades instead. The per-call
 * `timeoutMs` still bounds the whole call independently.
 */
export const SYSTEMONE_429_RETRY_BUDGET_MS = 3000

/**
 * Base delay (ms) of the exponential backoff used when the 429 carries no
 * usable `Retry-After`: attempt n waits within [base·2ⁿ/2, base·2ⁿ]
 * ("equal jitter"), i.e. 100–200ms then 200–400ms.
 */
const SYSTEMONE_429_BACKOFF_BASE_MS = 200

/**
 * Upper clamp (ms) for a server-sent `Retry-After`: a huge or far-future value
 * is clamped to this, and the clamped wait must still fit the retry budget.
 */
export const SYSTEMONE_429_RETRY_AFTER_CAP_MS = 2000

/**
 * Fixed failure reason of a run whose `attemptObserver` refused the dispatch:
 * the attempt never reached fetch, so nothing was spent on it.
 */
export const SYSTEMONE_OBSERVER_REJECTED_REASON = 'observer rejected dispatch'

/** Injectable timing seams for the 429 retry loop (tests pass fakes). */
export interface SystemOneRetryClock {
  /** Wall clock in ms (default `Date.now`). */
  now?: () => number
  /** Abortable sleep (default `setTimeout`); must resolve early when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Uniform [0, 1) source for backoff jitter (default `Math.random`). */
  random?: () => number
}

/** RFC 9110 `delay-seconds`: a non-negative integer, nothing else. */
const RETRY_AFTER_SECONDS = /^\d+$/

/** RFC 9110 IMF-fixdate shape, e.g. `Sun, 06 Nov 1994 08:49:37 GMT`. */
const RETRY_AFTER_IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/

/**
 * Parse a `Retry-After` header into a wait in ms. Only two shapes are
 * accepted: delay-seconds (a non-negative integer such as `"2"`) or an
 * IMF-fixdate (relative to `now`, floored at 0). Everything else — `"-1"`,
 * `"1.5"`, `"+3"`, other date spellings, garbage — returns `undefined` so the
 * caller falls back to backoff. The shape check runs before `Date.parse`
 * because V8's lenient parser reads strings like `"-1"` or `"1.5"` as dates
 * in 2001, which would turn into an immediate (0ms) retry.
 */
export function parseRetryAfterMs(header: string | null | undefined, now: number): number | undefined {
  if (header === null || header === undefined) return undefined
  const value = header.trim()
  if (RETRY_AFTER_SECONDS.test(value)) return Number(value) * 1000
  if (!RETRY_AFTER_IMF_FIXDATE.test(value)) return undefined
  const at = Date.parse(value)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - now)
}

/**
 * The wait before 429 retry number `retry` (0-based): the clamped
 * `Retry-After` when present, else equal-jitter exponential backoff.
 */
function retryDelayMs(retry: number, retryAfterMs: number | undefined, random: () => number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, SYSTEMONE_429_RETRY_AFTER_CAP_MS)
  const ceiling = SYSTEMONE_429_BACKOFF_BASE_MS * 2 ** retry
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

/** Default abortable sleep. */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** One typed-decision question sent to the System One face. */
export interface SystemOneQuestion {
  type: 'choice' | 'score' | 'noul'
  instructions: string
  criteria?: Record<string, string> | readonly string[]
}

/** One parsed answer entry from the `answers` envelope. */
export interface SystemOneAnswer {
  type: 'choice' | 'score' | 'noul'
  choice?: string
  probabilities?: Record<string, number>
  score?: number
  noul?: number
  confidence?: number
}

/** Token usage reported by the gateway. */
export interface SystemOneUsage {
  input_tokens: number
  output_tokens: number
}

export type SystemOneFailure = 'timeout' | 'cancelled' | 'error' | 'malformed'

export type SystemOneResult =
  | { ok: true; model: string; answers: Record<string, SystemOneAnswer>; usage: SystemOneUsage }
  | { ok: false; failure: SystemOneFailure; reason: string }

/**
 * Per-attempt dispatch hooks for the decision runner. `beforeDispatch` runs
 * immediately before each fetch call (reserve the attempt's quota, return
 * `false` to veto the dispatch); `afterDispatch` runs after the response body
 * is read and before answer validation, for every attempt that reached fetch.
 * A hook that throws — or a veto — converts the run to `failure: 'error'`.
 * `attempt` is the zero-based attempt index (`0..maxRetries`), the same key the
 * runner uses for that attempt's quota permit.
 */
export interface SystemOneAttemptObserver {
  /** Immediate pre-flight for one attempt; `false` keeps it out of fetch. */
  beforeDispatch(input: { attempt: number; signal: AbortSignal }): Promise<boolean>
  /** Post-dispatch report for one attempt; `usage` is absent when unreadable. */
  afterDispatch(input: { attempt: number; usage?: SystemOneUsage }): Promise<void>
}

/**
 * Effective 429 retry cap: `opts.maxRetries` clamps into the `0..2` contract
 * (`0` = a single attempt), an omitted or non-finite value keeps the legacy
 * {@link SYSTEMONE_429_MAX_RETRIES}. Clamping — never widening — means a bad
 * caller value cannot extend the retry loop.
 */
function resolveMaxRetries(maxRetries: number | undefined): number {
  if (maxRetries === undefined || !Number.isFinite(maxRetries)) return SYSTEMONE_429_MAX_RETRIES
  return Math.min(SYSTEMONE_429_MAX_RETRIES, Math.max(0, Math.trunc(maxRetries)))
}

/**
 * `JSON.parse` that reports an unparseable body as `undefined` — no valid JSON
 * body parses to `undefined`, so the sentinel is unambiguous.
 */
function tryParseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

/**
 * Lenient usage read for `afterDispatch`: the raw `input_tokens` /
 * `output_tokens` of the parsed body when both are finite numbers, otherwise
 * `undefined`. Strict validation is deliberately NOT applied here — the
 * consumer validates — so an envelope that is metered but malformed still
 * settles at its actual usage downstream.
 */
function lenientUsage(parsed: unknown): SystemOneUsage | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const usage = (parsed as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) return undefined
  const input = (usage as { input_tokens?: unknown }).input_tokens
  const output = (usage as { output_tokens?: unknown }).output_tokens
  if (typeof input !== 'number' || typeof output !== 'number') return undefined
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined
  return { input_tokens: input, output_tokens: output }
}

/** Fixed-prefix reason for a run an attempt observer turned into `error`. */
function observerFailure(hook: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `attempt observer failed in ${hook}: ${detail}`
}

export async function systemoneDecide(opts: {
  baseURL: string
  model: string
  state: unknown
  questions: Record<string, SystemOneQuestion>
  timeoutMs: number
  apiKey?: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  /** Timing seams for the bounded 429 retry (defaults: real clock/timers). */
  clock?: SystemOneRetryClock
  /**
   * 429 retries after the first attempt, so at most `1 + maxRetries` wire
   * requests. `0` means a single attempt. Omitted keeps the legacy
   * {@link SYSTEMONE_429_MAX_RETRIES}; otherwise the value is clamped into
   * `0..2`. All existing wait-budget and timeout bounds still apply.
   */
  maxRetries?: number
  /**
   * Optional per-attempt hooks for the decision runner (quota reserve/settle).
   * Omitted keeps the legacy behaviour, bit-identical.
   */
  attemptObserver?: SystemOneAttemptObserver
}): Promise<SystemOneResult> {
  // Request pre-check (design doc §"Request pre-check"): an unusable request
  // never reaches the network, so an invalid request means zero fetch calls.
  const request = validateSystemOneRequest({
    model: opts.model,
    state: opts.state,
    questions: opts.questions,
    timeoutMs: opts.timeoutMs,
  })
  if (!request.ok) {
    return { ok: false, failure: 'malformed', reason: `systemone validation: ${request.code}` }
  }
  const observer = opts.attemptObserver
  const maxRetries = resolveMaxRetries(opts.maxRetries)
  const doFetch = opts.fetchImpl ?? fetch
  const now = opts.clock?.now ?? Date.now
  const sleep = opts.clock?.sleep ?? defaultSleep
  const random = opts.clock?.random ?? Math.random
  // Compose the per-call timeout with the caller's signal, mirroring the
  // abort composition in llm-classifier.ts: whichever fires first aborts the
  // in-flight request; attribution afterwards distinguishes caller abort
  // (cancelled) from the own timer (timeout).
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), Math.max(0, opts.timeoutMs))
  const signals = opts.signal === undefined ? [timeout.signal] : [timeout.signal, opts.signal]
  const signal = 'any' in AbortSignal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any(signals)
    : timeout.signal
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.apiKey !== undefined) headers.authorization = `Bearer ${opts.apiKey}`
  // `afterDispatch` cut point: exactly once per attempt that reached fetch, so
  // the runner settles the permit it reserved in `beforeDispatch`. A throwing
  // observer converts the run to `error` (returned, never swallowed).
  const reportDispatch = async (attempt: number, usage: SystemOneUsage | undefined): Promise<SystemOneResult | undefined> => {
    if (observer === undefined) return undefined
    try {
      await observer.afterDispatch(usage === undefined ? { attempt } : { attempt, usage })
      return undefined
    } catch (error) {
      return { ok: false, failure: 'error', reason: observerFailure('afterDispatch', error) }
    }
  }
  try {
    const url = `${opts.baseURL.replace(/\/$/, '')}/v1/systemone`
    const payload = JSON.stringify({ model: opts.model, state: opts.state, questions: opts.questions })
    const startedAt = now()
    let response: Response
    let body: string
    let parsed: unknown
    // Caller abort wins first: a mid-flight ESC is host noise, not a lane fault.
    const interrupted = (): SystemOneResult | undefined => {
      if (opts.signal?.aborted === true) return { ok: false, failure: 'cancelled', reason: 'caller aborted the request' }
      if (timeout.signal.aborted) return { ok: false, failure: 'timeout', reason: `timed out after ${opts.timeoutMs}ms` }
      return undefined
    }
    for (let attempt = 0; ; attempt++) {
      // `beforeDispatch` cut point: the runner reserves this attempt's permits
      // here. A `false` return (or a throw) keeps the attempt out of fetch, so
      // the whole run ends as `error` and nothing was spent on it.
      if (observer !== undefined) {
        let proceed: boolean
        try {
          proceed = await observer.beforeDispatch({ attempt, signal })
        } catch (error) {
          return { ok: false, failure: 'error', reason: observerFailure('beforeDispatch', error) }
        }
        if (!proceed) return { ok: false, failure: 'error', reason: SYSTEMONE_OBSERVER_REJECTED_REASON }
      }
      response = await doFetch(url, { method: 'POST', headers, body: payload, signal })
      const stopped = interrupted()
      if (stopped !== undefined) {
        // The attempt already reached fetch, so a permit is held: report it
        // once with no usage rather than ending with neither report nor throw
        // (the runner's finally owns the unknown-usage supplement for a thrown
        // dispatch).
        const reported = await reportDispatch(attempt, undefined)
        return reported ?? stopped
      }
      body = await response.text()
      parsed = tryParseJson(body)
      // Report BEFORE any validation: a non-ok status (429 included) and an
      // envelope that later fails validation both still settle at the usage
      // they actually consumed.
      const reported = await reportDispatch(attempt, lenientUsage(parsed))
      if (reported !== undefined) return reported
      // Bounded 429 retry: stop when attempts are spent, when the wait would
      // overrun the retry budget, or when it would reach the per-call timeout
      // (sleeping into the timeout would only turn this 429 into 'timeout').
      // The last 429 then degrades below as before.
      if (response.status !== 429 || attempt >= maxRetries) break
      const delay = retryDelayMs(attempt, parseRetryAfterMs(response.headers?.get?.('retry-after'), now()), random)
      const elapsed = now() - startedAt
      if (elapsed + delay > SYSTEMONE_429_RETRY_BUDGET_MS) break
      if (elapsed + delay >= opts.timeoutMs) break
      await sleep(delay, signal)
      const slept = interrupted()
      if (slept !== undefined) return slept
    }
    if (!response.ok) {
      // Non-200: 4xx means a client bug or gateway drift, not retryable
      // (probe: validation errors are HTTP 400 invalid_request_error); a 429
      // lands here only after the bounded retry above is exhausted.
      return {
        ok: false,
        failure: 'error',
        reason: `http ${response.status}: ${body.slice(0, 200)}`,
      }
    }
    if (parsed === undefined) {
      // HTTP success with an unparseable body: an invalid envelope, not a
      // transport error, and never retried.
      return { ok: false, failure: 'malformed', reason: 'systemone validation: invalid-envelope' }
    }
    // Strict, request-aware validation: a successful return means every asked
    // question has a type-matching, in-range answer, and usage is auditable.
    // The server model is kept as-is (never backfilled with the request alias).
    const validated = validateSystemOneResponse(opts.questions, parsed)
    if (!validated.ok) {
      return { ok: false, failure: 'malformed', reason: `systemone validation: ${validated.code}` }
    }
    return {
      ok: true,
      model: validated.value.model,
      answers: validated.value.answers,
      usage: validated.value.usage,
    }
  } catch (error) {
    if (opts.signal?.aborted === true) {
      return { ok: false, failure: 'cancelled', reason: 'caller aborted the request' }
    }
    if (timeout.signal.aborted) {
      return { ok: false, failure: 'timeout', reason: `timed out after ${opts.timeoutMs}ms` }
    }
    return { ok: false, failure: 'error', reason: (error as Error).message }
  } finally {
    clearTimeout(timer)
  }
}
