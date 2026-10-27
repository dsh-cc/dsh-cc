/**
 * Escalation bookkeeping (design §4 + §3.4): in-memory per-session map keyed
 * by the origin user-message seq, value `{ tierFloor, retriesUsed }` with
 * monotonic invariants.
 *
 * - Survives compaction: the origin seq is stable in the log (compaction
 *   replaces ranges; seqs are not renumbered).
 * - Resets empty on session resume, but the escalation chain is NOT lost with
 *   it (F-3): every escalation dispatch is a typed `moa-escalation` followup
 *   whose `{ originSeq, fromTier, toTier }` provenance is durable in the
 *   session log, so a retry turn whose entry is gone restores floor and
 *   retries from that record ({@link EscalationBookkeeping.restoreFromEscalations}).
 * - Invariant violations THROW — they are bugs, not runtime conditions.
 *
 * @module
 */

import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { TIER_COUNT } from './tiers.ts'

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
      /** TUI visibility (§3.5): rendered as a notice row, not human input. */
      form?: 'notice'
      summary?: string
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
   * Record one escalation retry: the turn moves from the live floor to a
   * HIGHER tier (§3.2 — same-model rungs may be skipped, so the jump is not
   * necessarily one rung), advancing the floor and the retry counter.
   */
  recordRetryUsed(seq: number, fromTier: number, toTier: number): void {
    if (!Number.isInteger(seq) || seq < 0) fail(`invalid origin seq ${seq}`)
    if (!Number.isInteger(fromTier) || !Number.isInteger(toTier)) {
      fail(`non-integer tier (${fromTier} → ${toTier}) for seq ${seq}`)
    }
    if (fromTier < 0 || fromTier >= TIER_COUNT || toTier < 0 || toTier >= TIER_COUNT) {
      fail(`tier out of range (${fromTier} → ${toTier}) for seq ${seq}`)
    }
    const existing = this.states.get(seq)
    const floor = existing?.tierFloor ?? fromTier
    if (fromTier !== floor) fail(`fromTier ${fromTier} ≠ live floor ${floor} for seq ${seq}`)
    if (toTier <= floor) fail(`toTier ${toTier} does not exceed the live floor ${floor} for seq ${seq}`)
    const retriesUsed = (existing?.retriesUsed ?? 0) + 1
    this.states.set(seq, { tierFloor: toTier, retriesUsed })
  }

  /**
   * F-3: rebuild one origin's entry from durable `moa-escalation` followups
   * (the in-memory entry is lost on crash/resume; the followups are not).
   * Floor = highest `toTier` recorded, retries = number of escalations
   * (at least one: the caller is serving a retry turn). Idempotent and
   * monotonic: never lowers a live floor or a live retry count. Throws on a
   * malformed record (tier non-integer or outside the ladder) — the caller
   * must refuse to apply it rather than fall back to the launch selection.
   */
  restoreFromEscalations(
    seq: number,
    escalations: readonly { fromTier: number; toTier: number }[],
  ): void {
    if (!Number.isInteger(seq) || seq < 0) fail(`invalid origin seq ${seq}`)
    if (escalations.length === 0) fail(`no escalation records to restore for seq ${seq}`)
    let floor = -1
    let previousTo: number | undefined
    for (const { fromTier, toTier } of escalations) {
      if (!Number.isInteger(fromTier) || !Number.isInteger(toTier)
        || fromTier < 0 || toTier < 0 || fromTier >= TIER_COUNT || toTier >= TIER_COUNT || toTier <= fromTier) {
        fail(`malformed escalation record (${fromTier} → ${toTier}) for seq ${seq}`)
      }
      if (previousTo !== undefined && fromTier !== previousTo) {
        fail(`inconsistent escalation chain (${previousTo} → ${fromTier}) for seq ${seq}`)
      }
      previousTo = toTier
      floor = Math.max(floor, toTier)
    }
    const existing = this.states.get(seq)
    this.states.set(seq, {
      tierFloor: Math.max(floor, existing?.tierFloor ?? 0),
      retriesUsed: Math.max(escalations.length, existing?.retriesUsed ?? 0),
    })
  }
}
