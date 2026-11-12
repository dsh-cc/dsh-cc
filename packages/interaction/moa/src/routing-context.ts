/**
 * Pure routing-state construction for context-routing v2 (design
 * docs/plans/2026-11-02-systemone-09-moa-context-routing.md §"State
 * construction rules").
 *
 * A bounded history slice is handed to the routing question so a follow-up
 * such as "continue" or "do the second option" can be resolved against the
 * conversation it refers to. The slice is deliberately small and closed:
 * three prior genuine user requests, one prior assistant answer as background
 * only, and the names of the last ten tool calls. Tool arguments, paths,
 * results, environment variables and any non-recognized record are never
 * copied — records are read STRUCTURALLY against the log shape already used
 * by judge.ts, so an unknown record is dropped rather than stringified.
 *
 * Budget: the token estimate covers the serialized state PLUS the fixed
 * routing question (which lives at the integration layer and is therefore
 * passed in), and drops whole objects in a fixed order. Serialized JSON is
 * never truncated mid-object.
 *
 * @module
 */

import { canonicalJson, estimateSystemOneTokens, S1_ENVELOPE_TOKENS, S1_MARGIN_TOKENS } from '@dsh-cc/systemone'

/** Fixed marker inserted by every middle-elision cap. */
export const OMISSION_MARKER = '[omitted]'

/** Upper bound on `currentRequest`; longer requests fall back to live routing. */
export const CURRENT_REQUEST_MAX_CODEPOINTS = 8000
/** Upper bound on one prior user request (first 400 + marker + last 400). */
export const PRIOR_USER_MAX_CODEPOINTS = 800
/** How many prior genuine user sources are carried. */
export const PRIOR_USER_SLOTS = 3
/** Upper bound on the prior assistant answer (first 600 + marker + last 600). */
export const ASSISTANT_MAX_CODEPOINTS = 1200
/** How many recognized tool/call records are carried. */
export const TOOL_CALL_SLOTS = 10

/**
 * Bounded routing state (design §"Input and public interface").
 *
 * `omitted` records what was left out, so a log row can report a non-silent
 * cut. It counts ENTRIES REMOVED, never entries present:
 * - `user`: genuine prior user messages (`user/message` with a genuine
 *   `source.kind === 'user'`, `seq <= watermark`, the `openingSeq` record
 *   excluded) that did not make the three-slot cut, plus each oldest-entry
 *   drop the budget fitter performs.
 * - `assistant`: whether the assistant background entry was dropped by the
 *   budget fitter. It stays `false` when an entry is carried or when there was
 *   no entry to drop.
 * - `tools`: recognized `tool/call` records that did not make the last-ten
 *   cut, plus each oldest-entry drop the budget fitter performs.
 */
export interface RoutingContext {
  version: 1
  currentRequest: string
  priorUserRequests: Array<{ seq: number; text: string }>
  priorAssistantAnswer?: { seq: number; text: string }
  recentToolCalls: Array<{ seq: number; name: string }>
  omitted: { user: number; assistant: boolean; tools: number }
}

/** Input of {@link buildRoutingContext}. */
export interface BuildRoutingContextInput {
  /** The already-captured genuine user opening text of this turn. */
  openingText: string
  /** Session log snapshot; read structurally, never stringified. */
  events: readonly unknown[]
  /** Decisions read only `seq <= watermark`. */
  watermark: number
  /**
   * Seq of the log record this opening already maps to, when it is durable.
   * Absent when the opening is captured but not yet written.
   */
  openingSeq?: number
}

/** Structurally readable view of the session events this module folds. */
interface LogEvent {
  seq: number
  type: string
  data: {
    turn?: number
    source?: { kind?: string }
    content?: { type: string; text?: string }[]
    message?: { content?: { type: string; text?: string }[] }
    name?: string
  }
}

/** Structural guard: a record with a numeric seq, a string type and object data. */
function asLogEvent(value: unknown): LogEvent | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { seq?: unknown; type?: unknown; data?: unknown }
  if (typeof record.seq !== 'number' || !Number.isFinite(record.seq)) return undefined
  if (typeof record.type !== 'string') return undefined
  if (typeof record.data !== 'object' || record.data === null) return undefined
  return record as unknown as LogEvent
}

/** Plain-text projection of message content blocks (same rule as judge.ts). */
function textBlocks(content: { type: string; text?: string }[] | undefined): string {
  return (content ?? [])
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n')
}

/** Codepoint length — never UTF-16 length, so surrogate pairs count once. */
function codepointLength(text: string): number {
  return Array.from(text).length
}

/**
 * Middle-elision cap in CODEPOINTS: `cap` codepoints or fewer survive
 * verbatim; otherwise keep the first `cap / 2` and the last `cap / 2` joined
 * by {@link OMISSION_MARKER}. Never splits a surrogate pair.
 */
function capMiddle(text: string, cap: number): string {
  const points = Array.from(text)
  if (points.length <= cap) return text
  const half = Math.floor(cap / 2)
  return `${points.slice(0, half).join('')}${OMISSION_MARKER}${points.slice(points.length - half).join('')}`
}

/** Shallow copy so the budget fitter never mutates its input. */
function cloneContext(context: RoutingContext): RoutingContext {
  return {
    version: context.version,
    currentRequest: context.currentRequest,
    priorUserRequests: context.priorUserRequests.map((entry) => ({ ...entry })),
    ...(context.priorAssistantAnswer === undefined ? {} : { priorAssistantAnswer: { ...context.priorAssistantAnswer } }),
    recentToolCalls: context.recentToolCalls.map((entry) => ({ ...entry })),
    omitted: { ...context.omitted },
  }
}

/**
 * Build the bounded routing state, or `undefined` when the current request
 * cannot be classified at all: whitespace-only input, or more than
 * {@link CURRENT_REQUEST_MAX_CODEPOINTS} codepoints (never truncated — the
 * caller records the fixed `oversized-current-request` reason and falls back
 * to live selection).
 *
 * An empty history is still valid state: the current request alone classifies.
 */
export function buildRoutingContext(input: BuildRoutingContextInput): RoutingContext | undefined {
  const currentRequest = input.openingText
  if (currentRequest.trim().length === 0) return undefined
  if (codepointLength(currentRequest) > CURRENT_REQUEST_MAX_CODEPOINTS) return undefined

  // Recognized records at or before the watermark, ascending by seq so the
  // "most recent" cut is `slice(-n)` and the emitted arrays are ordered.
  const recognized: LogEvent[] = []
  for (const raw of input.events) {
    const event = asLogEvent(raw)
    if (event !== undefined && event.seq <= input.watermark) recognized.push(event)
  }
  recognized.sort((left, right) => left.seq - right.seq)

  // Rule 2: the most recent three genuine user sources, excluding the record
  // the current opening points at. Identical texts are NEVER deduplicated —
  // history may legitimately contain another request with the same text.
  const genuineUsers = recognized.filter(
    (event) => event.type === 'user/message' && event.data.source?.kind === 'user',
  )
  const priorCandidates =
    input.openingSeq === undefined ? genuineUsers : genuineUsers.filter((event) => event.seq !== input.openingSeq)
  const keptUsers = priorCandidates.slice(-PRIOR_USER_SLOTS)
  const priorUserRequests = keptUsers.map((event) => ({
    seq: event.seq,
    text: capMiddle(textBlocks(event.data.content), PRIOR_USER_MAX_CODEPOINTS),
  }))

  // Rule 3: the most recent assistant answer, background only. An event whose
  // text projection is empty carries no background and is skipped.
  let priorAssistantAnswer: { seq: number; text: string } | undefined
  for (let index = recognized.length - 1; index >= 0; index -= 1) {
    const event = recognized[index]!
    if (event.type !== 'assistant/message') continue
    const answer = textBlocks(event.data.message?.content)
    if (answer.length === 0) continue
    priorAssistantAnswer = { seq: event.seq, text: capMiddle(answer, ASSISTANT_MAX_CODEPOINTS) }
    break
  }

  // Rule 4: name + seq only. Arguments, results and environment values are
  // never read. A tool/call without a string name is not a recognized record.
  const toolCalls = recognized.filter((event) => event.type === 'tool/call' && typeof event.data.name === 'string')
  const keptTools = toolCalls.slice(-TOOL_CALL_SLOTS)
  const recentToolCalls = keptTools.map((event) => ({ seq: event.seq, name: event.data.name as string }))

  return {
    version: 1,
    currentRequest,
    priorUserRequests,
    ...(priorAssistantAnswer === undefined ? {} : { priorAssistantAnswer }),
    recentToolCalls,
    omitted: {
      user: priorCandidates.length - keptUsers.length,
      assistant: false,
      tools: toolCalls.length - keptTools.length,
    },
  }
}

/**
 * Rule 5: fit the state plus the routing question into `maxInputTokens`,
 * mirroring how `estimateDecisionInputTokens` composes the shared estimator
 * and envelope/margin constants so the two estimators agree.
 *
 * Drop order, one step at a time with a re-estimate after each: the assistant
 * entry, then the oldest prior user, then the oldest tool call. Whole objects
 * are removed (serialized JSON is never truncated); `omitted` is updated on
 * every drop. Still over budget after the third step ⇒ `undefined` ("do not
 * call"). A non-finite budget is treated as unusable for the same reason.
 */
export function fitRoutingContextToBudget(
  context: RoutingContext,
  questionJson: string,
  maxInputTokens: number,
): RoutingContext | undefined {
  if (!Number.isFinite(maxInputTokens)) return undefined
  const estimate = (candidate: RoutingContext): number =>
    S1_ENVELOPE_TOKENS +
    estimateSystemOneTokens(canonicalJson(candidate)) +
    estimateSystemOneTokens(questionJson) +
    S1_MARGIN_TOKENS

  let candidate = cloneContext(context)
  if (estimate(candidate) <= maxInputTokens) return candidate

  if (candidate.priorAssistantAnswer !== undefined) {
    const { priorAssistantAnswer: _dropped, ...rest } = candidate
    candidate = { ...rest, omitted: { ...candidate.omitted, assistant: true } }
    if (estimate(candidate) <= maxInputTokens) return candidate
  }

  if (candidate.priorUserRequests.length > 0) {
    candidate = {
      ...candidate,
      priorUserRequests: candidate.priorUserRequests.slice(1),
      omitted: { ...candidate.omitted, user: candidate.omitted.user + 1 },
    }
    if (estimate(candidate) <= maxInputTokens) return candidate
  }

  if (candidate.recentToolCalls.length > 0) {
    candidate = {
      ...candidate,
      recentToolCalls: candidate.recentToolCalls.slice(1),
      omitted: { ...candidate.omitted, tools: candidate.omitted.tools + 1 },
    }
    if (estimate(candidate) <= maxInputTokens) return candidate
  }

  return undefined
}
