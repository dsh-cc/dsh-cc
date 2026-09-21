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
  /** Evidence-preserving reducer master flag (§3.2). Defaults to `false`. */
  'reducer-enabled'?: boolean
  /** Regex sources matched against the invocation command line (§3.2). */
  'reducer-commands'?: string[]
  /** Head/tail truncation threshold in tokens (§3.3). Defaults to 30000. */
  'reducer-max-input-tokens'?: number
  /** Verifier size-gain ratio (§3.4.4). Defaults to 0.5. */
  'reducer-min-savings-ratio'?: number
  /** Side-query output token cap (§3.3). Defaults to 1024. */
  'reducer-max-tokens'?: number
  /** Side-query wall-clock budget in ms (§3.3). Defaults to 10000. */
  'reducer-timeout-ms'?: number
  /** Cheap-lane alias for the side query (§3.3). Defaults to 'haiku'. */
  'reducer-alias'?: string
}

/** Validated, detached, deeply immutable configuration. */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly mode: CrusherMode
  readonly minBytes: number
  readonly minSavingsRatio: number
  readonly protectedTools: readonly string[]
  /** Compiled command patterns (§3.2); invalid user regexes are dropped at resolve time. */
  readonly reducerEnabled: boolean
  readonly reducerCommands: readonly RegExp[]
  readonly reducerMaxInputTokens: number
  readonly reducerMinSavingsRatio: number
  readonly reducerMaxTokens: number
  readonly reducerTimeoutMs: number
  readonly reducerAlias: string
}

/** One append-only savings-ledger row (`savings.jsonl`). */
export interface LedgerRow {
  readonly ts: string
  readonly sessionId: string
  readonly tool: string
  /** Router kind that fired, or the reason a gate passed through. */
  readonly kind: 'search' | 'log' | 'receipt'
  /**
   * Reducer-only detail: why the attempt did not apply (§3.4) —
   * `lane-missing`, `lane-inherited`, `lane-timeout`, `lane-error`,
   * `malformed`, or `verify:<check>`. Absent on plain router rows.
   */
  readonly reason?: string
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
