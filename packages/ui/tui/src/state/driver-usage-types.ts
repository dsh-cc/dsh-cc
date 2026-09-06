/**
 * Usage/projection state types shared by the HUD, the `/usage` panel and
 * `/cost`. Extracted from driver-types.ts to keep that file focused on the
 * Driver interface and its structural service seams.
 * @module @dsh-cc/tui/state/driver-usage-types
 */

/**
 * `tokenUsage` projection state. `uncachedInputTokens` is the harness's
 * field name; `inputTokens` is accepted defensively so a shape drift
 * degrades to "no tokens" instead of NaN. Cache fields are optional —
 * compositions without prompt caching simply omit those lines. `last`
 * (when present) carries the most recent API step's per-response token
 * buckets — the CC `current_usage` semantics; it is read defensively too,
 * since state may arrive as a foreign/partial shape.
 */
export type TokenUsageStateLike = {
  totals?: {
    uncachedInputTokens?: number
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  last?: {
    turn?: number
    step?: number
    buckets?: {
      uncachedInputTokens?: number
      inputTokens?: number
      outputTokens?: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
    }
  }
}

/** Normalized token totals shared by the HUD and `/cost`. */
export interface TokenUsageTotals {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/** `contextPressure` projection state (subset the HUD reads). */
export type ContextPressureStateLike = {
  contextWindow?: number
  pressureTokens?: number
  surfaceTokens?: number
  sampledSurfaceTokens?: number
}

/**
 * `contextBreakdown` projection state (subset the usage panel reads): the
 * projected context token count per content role.
 */
export type ContextBreakdownStateLike = {
  system?: number
  tools?: number
  messages?: number
}
