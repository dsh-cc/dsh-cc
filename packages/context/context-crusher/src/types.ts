/**
 * Configuration types for the CCR tool-output crusher.
 * @module @dsh-cc/context-crusher/types
 */

/** Compression mode. `dry-run` measures only; `on` replaces tool results. */
export type CrusherMode = 'dry-run' | 'on'

/**
 * Plugin configuration: row-level deployment defaults overlaid by the live
 * `cc-context-compression` settings scope. Kebab keys match the settings keys
 * exactly (the plan names them `min-bytes` / `min-savings-ratio` /
 * `protected-tools`; keep those spellings).
 */
export interface CrusherConfig {
  /** Master flag. Defaults to `false` — the feature is opt-in. */
  enabled?: boolean
  /** `'dry-run'` (default) measures and ledgers only; `'on'` replaces. */
  mode?: CrusherMode
  /**
   * Minimum size before a result is eligible, expressed in tokenMeter tokens
   * (sizing is token-based; only the settings key keeps the legacy name).
   * Defaults to `8192`.
   */
  'min-bytes'?: number
  /** Minimum tokensAfter/tokensBefore saving ratio. Defaults to `0.4`. */
  'min-savings-ratio'?: number
  /**
   * Protected tool names that are NEVER crushed. REPLACE semantics: an
   * explicitly set list replaces the defaults entirely (not a union).
   */
  'protected-tools'?: string[]
}

/** Validated, detached, deeply immutable configuration. */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly mode: CrusherMode
  readonly minBytes: number
  readonly minSavingsRatio: number
  readonly protectedTools: readonly string[]
}

/** One append-only savings-ledger row (`savings.jsonl`). */
export interface LedgerRow {
  readonly ts: string
  readonly sessionId: string
  readonly tool: string
  /** Router kind that fired, or the reason a gate passed through. */
  readonly kind: 'search' | 'log'
  readonly charsBefore: number
  readonly charsAfter: number
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly applied: boolean
  /** Present only when the original was persisted to the store. */
  readonly hash?: string
}

/** Typed retrieval failure for one store lookup. */
export type RetrieveError = 'unknown_hash' | 'expired' | 'corrupt'
