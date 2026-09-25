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
 * same per-call timeout: honor `Retry-After` (delta-seconds or HTTP-date,
 * clamped), otherwise exponential backoff with jitter. Attempts AND total
 * elapsed time are capped so a permission decision is never stalled for long;
 * once the budget is spent the last 429 falls through to the ordinary
 * `failure: 'error'` degradation, exactly as before retries existed.
 *
 * Never throws: every failure mode maps to a tagged `SystemOneResult`.
 *
 * @module @dsh-cc/permission-rules/systemone-client
 */

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
export const SYSTEMONE_429_BACKOFF_BASE_MS = 200

/**
 * Upper clamp (ms) for a server-sent `Retry-After`: a huge or far-future value
 * is clamped to this, and the clamped wait must still fit the retry budget.
 */
export const SYSTEMONE_429_RETRY_AFTER_CAP_MS = 2000

/** Injectable timing seams for the 429 retry loop (tests pass fakes). */
export interface SystemOneRetryClock {
  /** Wall clock in ms (default `Date.now`). */
  now?: () => number
  /** Abortable sleep (default `setTimeout`); must resolve early when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Uniform [0, 1) source for backoff jitter (default `Math.random`). */
  random?: () => number
}

/**
 * Parse a `Retry-After` header into a wait in ms: delta-seconds (`"2"`) or an
 * HTTP-date (relative to `now`, floored at 0). Returns `undefined` when the
 * header is absent or unparseable.
 */
export function parseRetryAfterMs(header: string | null | undefined, now: number): number | undefined {
  if (header === null || header === undefined) return undefined
  const value = header.trim()
  if (value.length === 0) return undefined
  if (/^\d+$/.test(value)) return Number(value) * 1000
  const at = Date.parse(value)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - now)
}

/**
 * The wait before 429 retry number `retry` (0-based): the clamped
 * `Retry-After` when present, else equal-jitter exponential backoff.
 */
export function retryDelayMs(retry: number, retryAfterMs: number | undefined, random: () => number): number {
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
 * Structurally validate one answer entry. Unknown `type` values are DROPPED
 * (not an error) — the gateway may evolve answer shapes independently.
 * Dependency-free on purpose (no zod).
 */
function parseAnswer(value: unknown): SystemOneAnswer | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const type = record.type
  if (type !== 'choice' && type !== 'score' && type !== 'noul') return undefined
  const answer: SystemOneAnswer = { type }
  if (typeof record.choice === 'string') answer.choice = record.choice
  if (typeof record.score === 'number') answer.score = record.score
  if (typeof record.noul === 'number') answer.noul = record.noul
  if (typeof record.confidence === 'number') answer.confidence = record.confidence
  if (typeof record.probabilities === 'object' && record.probabilities !== null) {
    const probabilities: Record<string, number> = {}
    for (const [key, prob] of Object.entries(record.probabilities as Record<string, unknown>)) {
      if (typeof prob === 'number') probabilities[key] = prob
    }
    answer.probabilities = probabilities
  }
  return answer
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
}): Promise<SystemOneResult> {
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
  try {
    const url = `${opts.baseURL.replace(/\/$/, '')}/v1/systemone`
    const payload = JSON.stringify({ model: opts.model, state: opts.state, questions: opts.questions })
    const startedAt = now()
    let response: Response
    let body: string
    // Caller abort wins first: a mid-flight ESC is host noise, not a lane fault.
    const interrupted = (): SystemOneResult | undefined => {
      if (opts.signal?.aborted === true) return { ok: false, failure: 'cancelled', reason: 'caller aborted the request' }
      if (timeout.signal.aborted) return { ok: false, failure: 'timeout', reason: `timed out after ${opts.timeoutMs}ms` }
      return undefined
    }
    for (let retry = 0; ; retry++) {
      response = await doFetch(url, { method: 'POST', headers, body: payload, signal })
      const stopped = interrupted()
      if (stopped !== undefined) return stopped
      body = await response.text()
      // Bounded 429 retry: stop when attempts are spent or the wait would
      // overrun the total budget; the last 429 then degrades below as before.
      if (response.status !== 429 || retry >= SYSTEMONE_429_MAX_RETRIES) break
      const delay = retryDelayMs(retry, parseRetryAfterMs(response.headers?.get?.('retry-after'), now()), random)
      if (now() - startedAt + delay > SYSTEMONE_429_RETRY_BUDGET_MS) break
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
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch (error) {
      return { ok: false, failure: 'error', reason: `response parse failed: ${(error as Error).message}` }
    }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as Record<string, unknown>).answers !== 'object' || (parsed as Record<string, unknown>).answers === null) {
      return { ok: false, failure: 'malformed', reason: 'systemone response failed schema validation' }
    }
    const envelope = parsed as { model?: unknown; answers: Record<string, unknown>; usage?: unknown }
    const answers: Record<string, SystemOneAnswer> = {}
    for (const [key, raw] of Object.entries(envelope.answers)) {
      const answer = parseAnswer(raw)
      if (answer !== undefined) answers[key] = answer
    }
    if (Object.keys(answers).length === 0) {
      return { ok: false, failure: 'malformed', reason: 'systemone response failed schema validation' }
    }
    const usageRecord = (typeof envelope.usage === 'object' && envelope.usage !== null ? envelope.usage : {}) as Record<string, unknown>
    return {
      ok: true,
      model: typeof envelope.model === 'string' ? envelope.model : opts.model,
      answers,
      usage: {
        input_tokens: typeof usageRecord.input_tokens === 'number' ? usageRecord.input_tokens : 0,
        output_tokens: typeof usageRecord.output_tokens === 'number' ? usageRecord.output_tokens : 0,
      },
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
