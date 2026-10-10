/**
 * Pre-step opening-message capture (design §3.2, grok r5/r6 pins).
 *
 * At `agent/request` time the CURRENT turn's user messages are NOT yet in
 * session history (`prepareRequest` emits `agent/request` before the accepted
 * `user/message` batch is appended), so classification input must be captured
 * earlier. This capture-only `agent/pre-step` listener records, on the turn's
 * FIRST pre-step (turn-id not yet recorded), `turn-id →` the LAST element of
 * `payload.messages` — the claimed batch may carry a LEADING queued notice
 * (an `agent/created` inject, a status row), and `inbox.claim` appends the
 * next-turn message AFTER every pending message, so the opening message is
 * the batch's LAST element, never its first (grok r6).
 *
 * Synchronous, no LLM call, no history read; `next()` is always called and
 * the decision passed through unchanged.
 *
 * Storage: a bounded FIFO `Map` (capacity 8) keyed by turn-id. Live turns
 * capture on their FIRST pre-step, so the active turn is never evicted under
 * well-ordered harness flow; the cap only bounds pathological interleavings
 * (e.g. many queued followups). Oldest turn ids are dropped first.
 *
 * @module
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** Maximum simultaneously-captured turns. */
export const CAPTURE_CAPACITY = 8

/** Minimal structural view of the `agent/pre-step` payload this module needs. */
export interface PreStepPayload {
  messages: readonly UserMessage[]
  turn: number
}

export interface OpeningCapture {
  /**
   * The capture listener: on a turn's FIRST pre-step records the claimed
   * batch's LAST element, then always passes the decision through.
   */
  listener(payload: PreStepPayload, next: () => Promise<unknown>): Promise<unknown>
  /** The captured opening message for a turn, or undefined. */
  getCapturedOpening(turnId: number): UserMessage | undefined
}

export function createOpeningCapture(): OpeningCapture {
  const captured = new Map<number, UserMessage>()
  return {
    listener: async (payload, next) => {
      if (!captured.has(payload.turn)) {
        const opening = payload.messages[payload.messages.length - 1]
        if (opening !== undefined) {
          captured.set(payload.turn, opening)
          while (captured.size > CAPTURE_CAPACITY) {
            const oldest = captured.keys().next().value
            if (oldest === undefined) break
            captured.delete(oldest)
          }
        }
      }
      return next()
    },
    getCapturedOpening: (turnId: number) => captured.get(turnId),
  }
}
