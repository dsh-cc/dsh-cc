/**
 * Evidence adaptation for the extraction coordinator (design
 * docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md §"State machine
 * and commit rules", §"Building a complete window from the event watermark").
 *
 * Two questions live here, both pure:
 * - WHERE does the review window end? The evidence head is the highest seq of a
 *   surface record that can carry a fact. Secondary sources (`memory`
 *   injections, completion reminders, advisor/subagent notices) neither enter a
 *   window nor advance the head, so a stop whose only new record is an injection
 *   starts no work and no watermark move.
 * - HOW BIG is the whole-session batch? The legacy prompt counts every
 *   model-visible surface event, so the fallback keeps its original wording.
 *
 * @module @dsh-cc/memory-consolidation/extraction-evidence
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Surface event types that can carry reviewable evidence. */
export const SURFACE_EVENT_TYPES: ReadonlySet<string> = new Set(['user/message', 'assistant/message', 'tool/result'])

/**
 * Narrow a host seq to the coordinator's numeric watermark, when it is safe. The
 * window builder keeps the host's own seq identity; the coordinator's
 * `reviewedThrough`/`pendingHead` are numbers by design, so this is the explicit
 * conversion point (a non-integer or negative seq is not reviewable, never
 * guessed).
 * @param value - the raw seq of a host record.
 * @returns the safe non-negative integer, or `undefined`.
 */
export function narrowSeq(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Whether a user/message event is user-authored. A `memory` injection, a
 * completion reminder, an advisor note or a subagent notice is never a source of
 * fact and never advances the evidence head; the absent `source` arm is a
 * defensive tolerance, not a second admission rule.
 * @param source - the message's `source` field.
 * @returns whether the message is user input.
 */
export function isUserAuthored(source: unknown): boolean {
  if (source === undefined || source === null) return true
  if (typeof source !== 'object') return false
  return (source as { kind?: unknown }).kind === 'user'
}

/**
 * The highest seq of reviewable evidence in one snapshot.
 * @param events - the session event snapshot.
 * @returns the evidence head, or `undefined` when nothing is reviewable.
 */
export function evidenceHeadOf(events: readonly SessionEvent[]): number | undefined {
  let head: number | undefined
  for (const event of events) {
    if (!SURFACE_EVENT_TYPES.has(event.type)) continue
    if (event.type === 'user/message' && !isUserAuthored((event.data as { source?: unknown }).source)) continue
    const seq = narrowSeq((event as { seq?: unknown }).seq)
    if (seq === undefined) continue
    head = head === undefined ? seq : Math.max(head, seq)
  }
  return head
}

/**
 * How many model-visible surface events a whole-session batch reviews.
 * @param events - the session event snapshot.
 * @returns the surface event count.
 */
export function surfaceCountOf(events: readonly SessionEvent[]): number {
  let count = 0
  for (const event of events) if (SURFACE_EVENT_TYPES.has(event.type)) count += 1
  return count
}
