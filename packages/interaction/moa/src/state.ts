/**
 * Escalation bookkeeping (design §4 + §3.4): in-memory per-session map keyed
 * by the origin user-message seq, value `{ tierFloor, retriesUsed }` with
 * monotonic invariants.
 *
 * - Survives compaction: the origin seq is stable in the log (compaction
 *   replaces ranges; seqs are not renumbered).
 * - Resets empty on session resume (accepted §4 tradeoff: a resumed session
 *   may grant one extra escalation per message, documented rather than
 *   event-sourced).
 * - Invariant violations THROW — they are bugs, not runtime conditions.
 *
 * @module
 */

import type { MessageSource } from '@deepseek-ai/dsh-llm'

/** Typed provenance kind for escalation followups (§3.4). */
export const MOA_ESCALATION_KIND = 'moa-escalation' as const

/** Module augmentation for the typed followup source (registry.ts precedent). */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    moaEscalation: {
      kind: 'moa-escalation'
      originSeq: number
      fromTier: number
      toTier: number
    }
  }
}

/** Structural guard for the typed escalation source. */
export function isMoaEscalationMessage(source: MessageSource | undefined | null): boolean {
  if (source === undefined || source === null || typeof source !== 'object') return false
  const s = source as { kind?: unknown; originSeq?: unknown; fromTier?: unknown; toTier?: unknown }
  if (s.kind !== MOA_ESCALATION_KIND) return false
  return typeof s.originSeq === 'number' && typeof s.fromTier === 'number' && typeof s.toTier === 'number'
}

/** Per-origin-seq escalation state (§3.4 guards). */
export interface EscalationState {
  tierFloor: number
  retriesUsed: number
}

function fail(message: string): never {
  throw new Error(`moa escalation bookkeeping invariant violated: ${message}`)
}

/**
 * Monotonic bookkeeping for one session. Pure data structure; the wiring
 * slice owns the instance lifetime (per session, reset on resume).
 */
export class EscalationBookkeeping {
  private readonly states = new Map<number, EscalationState>()

  /** `floorFor(seq)` — the tier floor, or undefined when unrecorded. */
  floorFor(seq: number): number | undefined {
    return this.states.get(seq)?.tierFloor
  }

  /** The live state entry (or undefined). */
  stateFor(seq: number): EscalationState | undefined {
    const state = this.states.get(seq)
    return state === undefined ? undefined : { ...state }
  }

  /**
   * Record the tier floor for an origin seq (classify on the first request,
   * or a higher-tier retry). Never decreases; retriesUsed never decreases.
   */
  recordFloor(seq: number, tier: number): void {
    if (!Number.isInteger(seq) || seq < 0) fail(`invalid origin seq ${seq}`)
    if (!Number.isInteger(tier) || tier < 0) fail(`invalid tier ${tier}`)
    const existing = this.states.get(seq)
    if (existing !== undefined && tier < existing.tierFloor) {
      fail(`tier floor for seq ${seq} would decrease (${existing.tierFloor} → ${tier})`)
    }
    this.states.set(seq, { tierFloor: tier, retriesUsed: existing?.retriesUsed ?? 0 })
  }

  /**
   * Record one escalation retry: the turn moves from `fromTier` to `toTier`
   * (strictly upward), advancing the floor and the retry counter.
   */
  recordRetryUsed(seq: number, fromTier: number, toTier: number): void {
    if (!Number.isInteger(seq) || seq < 0) fail(`invalid origin seq ${seq}`)
    if (!Number.isInteger(fromTier) || !Number.isInteger(toTier)) {
      fail(`non-integer tier (${fromTier} → ${toTier}) for seq ${seq}`)
    }
    const existing = this.states.get(seq)
    const floor = existing?.tierFloor ?? fromTier
    if (fromTier !== floor) fail(`fromTier ${fromTier} ≠ live floor ${floor} for seq ${seq}`)
    if (toTier !== floor + 1) fail(`toTier ${toTier} is not floor+1 (${floor}) for seq ${seq}`)
    const retriesUsed = (existing?.retriesUsed ?? 0) + 1
    this.states.set(seq, { tierFloor: toTier, retriesUsed })
  }
}
