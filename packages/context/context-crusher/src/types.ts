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
  /**
   * Deferred externalization residency (design §3.6): eligible results are
   * stored immediately but enter the session UNMODIFIED, and are swapped to
   * the standard stub after this many counted main-loop sends
   * (`2` = paper parity). `0` (default) disables deferral — behavior is
   * byte-identical to immediate mode.
   */
  'defer-requests'?: number
  /** Suffix-cost gate multiplier for the deferred swap. Defaults to `1.5`. */
  'defer-margin'?: number
  /** Sweep age (ms) for residents that never swapped. Defaults to `1_800_000`. */
  'defer-max-age-ms'?: number
  /**
   * Window-pressure override distance in tokens: when the session estimate
   * comes within this distance of the model window, residents swap
   * regardless of the gate. Unset = inactive (also inactive without a
   * window source).
   */
  'defer-urgency-tokens'?: number
  /**
   * Nested reducer decision-gate settings (S1-12). The ONLY deep-merged
   * object: unlike the legacy flat keys (which replace wholesale), a partial
   * object overrides per key at both merge points. Parsed tolerantly — an
   * invalid value degrades the gate to off for that resolution, never throws.
   */
  'reducer-decision-gate'?: ReducerGateRawConfig
}

/** Reducer decision-gate mode (S1-12): `off` dormant, `shadow` judges without applying, `active` may skip generation. */
export type ReducerGateMode = 'off' | 'shadow' | 'active'

/**
 * Raw nested `reducer-decision-gate` object under `cc-context-compression`
 * (S1-12). Every value is `unknown` on purpose: the object is parsed
 * TOLERANTLY at resolution — an out-of-range or mistyped value degrades the
 * gate to off for that resolution and must never throw, so callers may pass
 * anything here.
 */
export interface ReducerGateRawConfig {
  mode?: unknown
  'timeout-ms'?: unknown
  'max-input-tokens'?: unknown
  'max-source-tokens'?: unknown
  'max-chunks'?: unknown
  'max-skip-index'?: unknown
  'max-compressibility'?: unknown
  'cache-entries'?: unknown
  'cache-ttl-ms'?: unknown
  [key: string]: unknown
}

/** Resolved reducer decision-gate settings (camelCase; ranges validated tolerantly). */
export interface ReducerGateConfig {
  /** Gate mode; `off` by default. `shadow` judges but always continues the original generation. */
  readonly mode: ReducerGateMode
  /** Wall-clock budget shared by the whole group judgement (100–3000). */
  readonly timeoutMs: number
  /** Per-request input cap including state, questions and headroom (512–16384). */
  readonly maxInputTokens: number
  /** Cap on the complete source text (512–32768). */
  readonly maxSourceTokens: number
  /** Maximum chunk count for one judgement (1–16). */
  readonly maxChunks: number
  /** Skip threshold on the receiptOpportunity score, inclusive (0–4). */
  readonly maxSkipIndex: number
  /** Skip threshold on the compressibility noul, inclusive (0–1). */
  readonly maxCompressibility: number
  /** Cached judgments retained; `0` disables storage (0–1024). */
  readonly cacheEntries: number
  /** Entry lifetime in ms; `0` makes no entry reusable (0–300000). */
  readonly cacheTtlMs: number
  /**
   * `false` when a provided value violated its row: the gate is OFF for that
   * resolution (the existing reducer continues). Config errors must never be
   * read as reducer-disabled.
   */
  readonly valid: boolean
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
  readonly deferRequests: number
  readonly deferMargin: number
  readonly deferMaxAgeMs: number
  readonly deferUrgencyTokens?: number
  /** Resolved reducer decision-gate settings (S1-12); default off. */
  readonly reducerDecisionGate: ReducerGateConfig
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
  /**
   * S1-12 correlation key: the decision id(s) of a decision-gate skip,
   * comma-joined when a multi-chunk judgment produced several. Additive only.
   */
  readonly decisionId?: string
}

/** Typed retrieval failure for one store lookup. */
export type RetrieveError = 'unknown_hash' | 'expired' | 'corrupt'
