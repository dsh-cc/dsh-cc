/**
 * Pure extraction-window builder (design
 * docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md §"Building a
 * complete window from the event watermark").
 *
 * The gate may only skip a fork against material it can reconstruct exactly:
 * the surface events between the reviewed watermark (exclusive) and the
 * captured evidence head (inclusive), plus the complete existing topic index.
 * Everything here is pure — the caller reads the index and hands the snapshot
 * in — so completeness, ordering, hashing and the budget decision are testable
 * without a host.
 *
 * A window that is not complete, or that does not fit the configured budget,
 * is NEVER sent to the SystemOne decision model: the gate falls back to the
 * legacy extraction path (the `extract` verdict with reason `incomplete` or
 * `over-budget`). A seq keeps the host's own identity (a string when the log
 * uses strings) throughout; it is narrowed to a safe integer only where the
 * design says so explicitly (`DecisionScope.originSeq` and the JSON state),
 * never here.
 *
 * @module @dsh-cc/memory-consolidation/extraction-window
 */

import { createHash } from 'node:crypto'
import { SURFACE_EVENT_TYPES } from './extraction-evidence.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * One host event seq in the host's own identity: a safe non-negative integer
 * for this harness, or the decimal string form a string-keyed log would use.
 */
export type ExtractionSeq = number | string

/** Conservative upper bound on the injected index: first 200 lines or 8 KiB. */
export const INDEX_CAP_LINES = 200
/** Byte budget of the injected index (mirrors `readExistingIndex` in index.ts). */
export const INDEX_CAP_BYTES = 8 * 1024

/** Event roles a window may carry; an assistant inference never becomes a user claim. */
export type ExtractionEventKind = 'user' | 'assistant' | 'tool'

/** One reviewed message: plain-text projection of a surface event. */
export interface ExtractionEvent {
  seq: ExtractionSeq
  kind: ExtractionEventKind
  text: string
  isError?: boolean
}

/** Why a window cannot go to the decision model. */
export type WindowExtractReason = 'incomplete' | 'over-budget'

/**
 * One review window over `(fromExclusive, throughInclusive]`, plus the
 * fingerprints the pre-commit check re-compares before a skip may advance the
 * watermark.
 */
export interface ExtractionWindow {
  /** Review watermark the window starts after; starts at -1 so seq 0 is never missed. */
  fromExclusive: ExtractionSeq
  /** Captured evidence head, inclusive. */
  throughInclusive: ExtractionSeq
  events: readonly ExtractionEvent[]
  /** Stable hash of the window identity (watermark + reviewed events). */
  evidenceHash: string
  /** Stable hash of {@link existingIndex}. */
  indexHash: string
  /** The complete existing topic index, `''` when the directory has none. */
  existingIndex: string
  /**
   * False when the window must not be sent to the decision model: the reviewed
   * material is unreconstructable, or the complete state does not fit the budget.
   */
  complete: boolean
  /** Set exactly when the gate must fall back to extraction instead of asking. */
  extractReason?: WindowExtractReason
}

/** Every reason a gate decision may end in (the reasons the gate may return). */
export type GateExtractReason = 'positive' | 'uncertain' | 'audit' | WindowExtractReason | 'unavailable'

/** The single-question gate verdict (the decision itself lives in the gate slice). */
export type GateVerdict =
  | { kind: 'skip'; probability: number; decisionId: string }
  | { kind: 'extract'; reason: GateExtractReason }
  | { kind: 'cancelled' }

/**
 * What the host index read yielded. The builder never touches the filesystem:
 * a failed read is a fact the caller observes, not something to guess.
 */
export type IndexSnapshot =
  | { kind: 'absent' }
  | { kind: 'text'; text: string }
  | { kind: 'failed' }

/** Inputs of {@link buildExtractionWindow}. */
export interface ExtractionWindowInput {
  /** The current session event snapshot, in host order. */
  readonly events: readonly SessionEvent[]
  /** Review watermark: events with a seq at or below it were already reviewed. */
  readonly reviewedThrough: ExtractionSeq
  /** Captured evidence head, inclusive. */
  readonly capturedHead: ExtractionSeq
  /** What the existing topic index read yielded. */
  readonly index: IndexSnapshot
  /** Event-count budget (`max-surface-events`). */
  readonly maxSurfaceEvents: number
  /** UTF-8 state budget (`max-state-bytes`). */
  readonly maxStateBytes: number
  /** Estimated-token budget of the complete state (`max-input-tokens`). */
  readonly maxInputTokens: number
}

// Surface event types whose content a single extraction batch reviews: the
// evidence module owns the one truth (issue #362: the exemption below reads it
// too, and a second copy would drift from `evidenceHeadOf`).

/** Content blocks deliberately carried into the state as reviewable text. */
const EVIDENCE_BLOCK_TYPE = 'text'
/** Recognized blocks that are never evidence and never make a window incomplete. */
const PRIVATE_BLOCK_TYPES: ReadonlySet<string> = new Set([
  // Model-internal deliberation: not a durable fact, and private.
  'reasoning',
  // Raw tool arguments must never enter the decision state (design §"Isolation").
  'tool-call',
])

const isSafeSeq = (value: unknown): value is ExtractionSeq =>
  typeof value === 'number'
    ? Number.isSafeInteger(value) && value >= 0
    : typeof value === 'string'
      ? /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value))
      : false

/** Numeric order of two validated seqs; identity is preserved at the call sites. */
const compareSeq = (a: ExtractionSeq, b: ExtractionSeq): number => Number(a) - Number(b)

/** Lower-bound codepoint weight (see {@link estimateStateTokens}). */
function codepointWeight(codePoint: string): number {
  if (codePoint.codePointAt(0)! > 0x7f) return 1.5
  if (/\s/.test(codePoint)) return 0.15
  if (/[a-zA-Z]/.test(codePoint)) return 0.22
  return 0.45
}

/**
 * Lower-bound token estimate of the serialized state.
 *
 * The weights mirror the S1 estimator (`estimateSystemOneTokens` in
 * `@dsh-cc/systemone`); they are duplicated here because this package does not
 * link that workspace package yet. A lower bound can only route a window to the
 * legacy extraction path, never send an over-budget state to the model, which is
 * the safe direction for a skip gate.
 * @param text - the serialized state.
 * @returns the estimated token count.
 */
export function estimateStateTokens(text: string): number {
  let tokens = 0
  for (const codePoint of text) tokens += codepointWeight(codePoint)
  return tokens
}

/** Plain-text projection of one message's content blocks. */
interface ContentProjection {
  readonly text: string
  readonly complete: boolean
}

/**
 * Project content blocks in order: every `text` block is kept verbatim, private
 * blocks are dropped, and anything that cannot be represented as reviewed text
 * (image, file, audio, an unknown producer's block, a malformed block) makes the
 * projection incomplete.
 */
function projectContent(content: unknown): ContentProjection {
  if (!Array.isArray(content)) return { text: '', complete: false }
  const texts: string[] = []
  let complete = true
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      complete = false
      continue
    }
    const type: unknown = (block as { type?: unknown }).type
    if (type === EVIDENCE_BLOCK_TYPE) {
      const text: unknown = (block as { text?: unknown }).text
      if (typeof text !== 'string') complete = false
      else texts.push(text)
      continue
    }
    if (typeof type === 'string' && PRIVATE_BLOCK_TYPES.has(type)) continue
    complete = false
  }
  return { text: texts.join('\n'), complete }
}

/** One surface event's adaptation: its evidence (when any) and completeness. */
interface AdaptedEvent {
  readonly complete: boolean
  readonly event?: ExtractionEvent
}

const SKIP_EVENT: AdaptedEvent = { complete: true }

/**
 * A real user message is user-authored only when its source producer kind is
 * `user`. The `source` field is required on every message in the current shape,
 * so the absent arm is a defensive tolerance, not a second admission rule —
 * plugin injections (`memory`, reminders, advisor, subagent notices) are never a
 * source of fact.
 */
function isUserAuthoredSource(source: unknown): boolean {
  if (source === undefined || source === null) return true
  if (typeof source !== 'object') return false
  return (source as { kind?: unknown }).kind === 'user'
}

/** Build one evidence event, keeping the host seq identity and the original role. */
function evidenceOf(
  seq: ExtractionSeq,
  kind: ExtractionEventKind,
  projection: ContentProjection,
  isError: boolean,
): AdaptedEvent {
  // A message with no plain-text content carries no evidence. This is only
  // reached with `complete` decided separately, so a dropped empty assistant
  // message never hides an unsupported block.
  if (projection.text.length === 0) return { complete: projection.complete }
  return {
    complete: projection.complete,
    event: {
      seq,
      kind,
      text: projection.text,
      ...(isError ? { isError: true } : {}),
    },
  }
}

/** Adapt one surface event to its evidence, reading the v4 shapes defensively. */
function adaptSurfaceEvent(event: SessionEvent, seq: ExtractionSeq): AdaptedEvent {
  switch (event.type) {
    case 'user/message': {
      const message = event.data as { content?: unknown; source?: unknown }
      if (!isUserAuthoredSource(message.source)) return SKIP_EVENT
      return evidenceOf(seq, 'user', projectContent(message.content), false)
    }
    case 'assistant/message': {
      const message = (event.data as { message?: { content?: unknown } }).message
      return evidenceOf(seq, 'assistant', projectContent(message?.content), false)
    }
    case 'tool/result': {
      const message = (event.data as { message?: { content?: unknown; isError?: unknown } }).message
      return evidenceOf(seq, 'tool', projectContent(message?.content), message?.isError === true)
    }
    default:
      return SKIP_EVENT
  }
}

/** A surface replacement's replaced range, `null` when the range is unusable. */
type ReplacementRange = { start: ExtractionSeq; end: ExtractionSeq } | null | undefined

/**
 * Read a surface replacement's replaced range. `undefined` means "not a
 * replacement" (`append` or no surface op at all); `null` means a replacement
 * whose range cannot be interpreted.
 */
function replacementRangeOf(event: SessionEvent): ReplacementRange {
  const op: unknown = (event as { surfaceOp?: unknown }).surfaceOp
  if (typeof op !== 'object' || op === null) return undefined
  const record = op as { op?: unknown; startSeq?: unknown; endSeq?: unknown }
  if (record.op !== 'replace') return undefined
  if (!isSafeSeq(record.startSeq) || !isSafeSeq(record.endSeq)) return null
  return { start: record.startSeq, end: record.endSeq }
}

/** Whether a replaced range `[start, end]` overlaps the review window. */
function intersectsWindow(range: { start: ExtractionSeq; end: ExtractionSeq }, fromExclusive: ExtractionSeq, throughInclusive: ExtractionSeq): boolean {
  return compareSeq(range.start, throughInclusive) <= 0 && compareSeq(range.end, fromExclusive) > 0
}

/**
 * Whether a replaced range is provably composed of known non-surface seqs
 * (issue #362): the session log is append-only, so the raw events at the
 * replaced seqs survive in the input — a replace that only rewrote non-surface
 * rows (the harness system-prompt snapshot projection replacing its own
 * predecessor `system/message`) destroyed no reviewable material and exempts
 * the window. Every fail direction is destructive: string or non-numeric
 * endpoints (never coerced), an inverted range, a log gap inside the range, a
 * surface-typed member, or a range longer than the indexed non-surface count
 * (the enumeration is bounded by that short-circuit).
 */
function isExemptReplace(range: { start: ExtractionSeq; end: ExtractionSeq }, nonSurfaceSeqs: ReadonlySet<number>): boolean {
  if (typeof range.start !== 'number' || typeof range.end !== 'number') return false
  if (range.start > range.end) return false
  if (range.end - range.start + 1 > nonSurfaceSeqs.size) return false
  for (let seq = range.start; seq <= range.end; seq += 1) {
    if (!nonSurfaceSeqs.has(seq)) return false
  }
  return true
}

/** Cap the existing index exactly as the legacy prompt injection does. */
function capIndexText(raw: string): { text: string; truncated: boolean } {
  const kept: string[] = []
  let bytes = 0
  for (const line of raw.split('\n')) {
    if (kept.length >= INDEX_CAP_LINES) return { text: kept.join('\n'), truncated: true }
    // UTF-8 bytes, so the cap is never looser than the char-counting injection.
    const add = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0)
    if (bytes + add > INDEX_CAP_BYTES) return { text: kept.join('\n'), truncated: true }
    kept.push(line)
    bytes += add
  }
  return { text: kept.join('\n'), truncated: false }
}

/** Resolve the index snapshot: absent is a complete empty index, truncation is not. */
function resolveIndex(snapshot: IndexSnapshot): { text: string; complete: boolean } {
  switch (snapshot.kind) {
    case 'absent':
      return { text: '', complete: true }
    case 'failed':
      return { text: '', complete: false }
    case 'text': {
      const capped = capIndexText(snapshot.text)
      // A truncated index is never sent and never admitted as reviewed material.
      return capped.truncated ? { text: '', complete: false } : { text: capped.text, complete: true }
    }
  }
}

/** Stable sha-256 hex fingerprint. */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The serialized decision state whose size the budgets bound. */
function serializeState(fromExclusive: ExtractionSeq, throughInclusive: ExtractionSeq, events: readonly ExtractionEvent[], existingIndex: string): string {
  return JSON.stringify({
    window: { fromExclusive, throughInclusive, events },
    existingIndex,
  })
}

/**
 * Build one extraction window.
 *
 * Rules (design §"Building a complete window from the event watermark"):
 * - only surface events (user/assistant/tool) inside `(fromExclusive,
 *   throughInclusive]` become evidence, in ascending seq order;
 * - `memory` injections, reminders, advisor and subagent notices never enter the
 *   window;
 * - a surface replacement whose replaced range intersects the window marks it
 *   unreconstructable, and the replacement node itself is never evidence;
 * - an image/file/unknown block, an invalid or missing seq, a failed or
 *   truncated index, and any budget overflow mark the window unusable, with
 *   `extractReason` naming the fallback (`incomplete` beats `over-budget`).
 * @param input - the event snapshot, watermark, index snapshot and budgets.
 * @returns the window, complete only when it may be sent to the decision model.
 */
export function buildExtractionWindow(input: ExtractionWindowInput): ExtractionWindow {
  const { events, reviewedThrough: fromExclusive, capturedHead: throughInclusive } = input
  const emptyHash = sha256Hex('')
  // An unusable watermark cannot bound a window: no evidence, no index, no send.
  if (!isSafeSeq(throughInclusive) || (fromExclusive !== -1 && !isSafeSeq(fromExclusive))) {
    return {
      fromExclusive,
      throughInclusive,
      events: [],
      evidenceHash: sha256Hex(JSON.stringify([fromExclusive, throughInclusive, []])),
      indexHash: emptyHash,
      existingIndex: '',
      complete: false,
      extractReason: 'incomplete',
    }
  }
  let complete = true
  // An inverted range means the caller lost the watermark: never treat it as an
  // (empty, skippable) window.
  if (compareSeq(fromExclusive, throughInclusive) > 0) complete = false
  // One pass first: which numeric seqs are non-surface rows (issue #362). The
  // log is append-only, so this index sees the raw rows a later replace names —
  // including rows a post-replace projection would have dropped.
  const nonSurfaceSeqs = new Set<number>()
  for (const event of events) {
    if (SURFACE_EVENT_TYPES.has(event.type)) continue
    const seq: unknown = (event as { seq?: unknown }).seq
    if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0) nonSurfaceSeqs.add(seq)
  }
  const collected: ExtractionEvent[] = []
  let surfaceCount = 0
  for (const event of events) {
    const replacement = replacementRangeOf(event)
    if (replacement !== undefined) {
      // Compaction rule: the summary node is never evidence, and any replaced
      // range overlapping the window leaves unreviewable material behind —
      // unless the replaced range is provably composed of non-surface rows
      // (issue #362: such a replace destroyed nothing reviewable).
      if (replacement === null) complete = false
      else if (intersectsWindow(replacement, fromExclusive, throughInclusive)
        && !isExemptReplace(replacement, nonSurfaceSeqs)) complete = false
      continue
    }
    if (!SURFACE_EVENT_TYPES.has(event.type)) continue
    const seq: unknown = (event as { seq?: unknown }).seq
    if (!isSafeSeq(seq)) {
      complete = false
      continue
    }
    if (compareSeq(seq, fromExclusive) <= 0 || compareSeq(seq, throughInclusive) > 0) continue
    surfaceCount += 1
    const adapted = adaptSurfaceEvent(event, seq)
    if (!adapted.complete) complete = false
    if (adapted.event !== undefined) collected.push(adapted.event)
  }
  collected.sort((a, b) => compareSeq(a.seq, b.seq))
  const resolvedIndex = resolveIndex(input.index)
  if (!resolvedIndex.complete) complete = false
  const existingIndex = resolvedIndex.text
  const state = serializeState(fromExclusive, throughInclusive, collected, existingIndex)
  const overBudget =
    surfaceCount > input.maxSurfaceEvents ||
    Buffer.byteLength(state, 'utf8') > input.maxStateBytes ||
    estimateStateTokens(state) > input.maxInputTokens
  // An over-budget window keeps its full event list (a reviewed window is never
  // trimmed) but must not be sent: the gate extracts directly.
  const extractReason: WindowExtractReason | undefined = !complete
    ? 'incomplete'
    : overBudget
      ? 'over-budget'
      : undefined
  return {
    fromExclusive,
    throughInclusive,
    events: collected,
    evidenceHash: sha256Hex(
      JSON.stringify([
        fromExclusive,
        throughInclusive,
        collected.map((event) => [event.seq, event.kind, event.text, event.isError ?? null]),
      ]),
    ),
    indexHash: sha256Hex(existingIndex),
    existingIndex,
    complete: extractReason === undefined,
    ...(extractReason === undefined ? {} : { extractReason }),
  }
}
