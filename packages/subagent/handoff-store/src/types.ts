/**
 * Types for the subagent handoff store.
 * @module @dsh-cc/handoff-store/types
 */

/** Optional metadata attached to one handoff artifact. */
export interface HandoffMeta {
  /** Short human/model-facing label (e.g. "critic review of plan X"). */
  readonly label?: string
  /** Originating agent name, when known (e.g. "critic"). */
  readonly agent?: string
}

/**
 * Live settings scope shape for the `cc-handoff` namespace. Kebab keys match
 * the settings keys exactly.
 */
export interface HandoffConfig {
  /** Master flag. Defaults to `true`. */
  enabled?: boolean
  /**
   * Advisory size threshold in chars: reports/artifacts above it should be
   * handed off with a summary. ADVISORY ONLY — `handoff_put` never enforces
   * or rejects on it.
   */
  'threshold-chars'?: number
}

/** One append-only handoff-ledger row (`handoff/ledger.jsonl`). */
export interface HandoffLedgerRow {
  readonly ts: string
  /** Project bucket key (sha256 of the putting session's cwd, 16 hex). */
  readonly project: string
  readonly sessionId: string
  readonly id: string
  readonly label?: string
  readonly agent?: string
  readonly chars: number
}

/** Typed retrieval failure for one handoff lookup. */
export type HandoffError = 'unknown_id' | 'expired' | 'corrupt'
