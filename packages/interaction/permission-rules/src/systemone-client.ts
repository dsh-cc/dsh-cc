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
 * Never throws: every failure mode maps to a tagged `SystemOneResult`.
 *
 * @module @dsh-cc/permission-rules/systemone-client
 */

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
}): Promise<SystemOneResult> {
  const doFetch = opts.fetchImpl ?? fetch
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
    const response = await doFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: opts.model, state: opts.state, questions: opts.questions }),
      signal,
    })
    // Caller abort wins first: a mid-flight ESC is host noise, not a lane fault.
    if (opts.signal?.aborted === true) {
      return { ok: false, failure: 'cancelled', reason: 'caller aborted the request' }
    }
    if (timeout.signal.aborted) {
      return { ok: false, failure: 'timeout', reason: `timed out after ${opts.timeoutMs}ms` }
    }
    const body = await response.text()
    if (!response.ok) {
      // Non-200: 4xx means a client bug or gateway drift, not retryable
      // (probe: validation errors are HTTP 400 invalid_request_error).
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
