/**
 * Pure projection→view mappers for the statusline HUD and the `/usage`
 * panel, extracted from harness/driver.ts. Structural reads over projection
 * state plus field-wise equality — no I/O and no harness state.
 * @module @dsh-cc/tui/harness/usage-view
 */

import type {
  ContextBreakdownStateLike,
  ContextPressureStateLike,
  TokenUsageStateLike,
  TokenUsageTotals,
} from '../state/driver-types.ts'
import type { TodoItemView, UsageBreakdownView, UsageView } from '../store.ts'

/** Pull cumulative token totals out of a `tokenUsage` state value. */
export function totalsOf(usage: TokenUsageStateLike | undefined): TokenUsageTotals | undefined {
  const totals = usage?.totals
  const input = totals?.uncachedInputTokens ?? totals?.inputTokens
  if (typeof input !== 'number' || typeof totals?.outputTokens !== 'number') return undefined
  return {
    input,
    output: totals.outputTokens,
    ...typeof totals.cacheReadTokens === 'number' ? { cacheRead: totals.cacheReadTokens } : {},
    ...typeof totals.cacheWriteTokens === 'number' ? { cacheWrite: totals.cacheWriteTokens } : {},
  }
}

/** HUD-shaped subset of {@link totalsOf} (input/output only). */
export function tokensOf(usage: TokenUsageStateLike | undefined): { input: number; output: number } | undefined {
  const totals = totalsOf(usage)
  return totals === undefined ? undefined : { input: totals.input, output: totals.output }
}

/**
 * Most recent API step's token buckets (the CC `current_usage` semantics)
 * out of a `tokenUsage` state value. Returns undefined unless both the
 * input (`uncachedInputTokens ?? inputTokens`) and output are finite
 * numbers; the cache fields are included only when finite numbers, so a
 * partial bucket degrades to its known members instead of NaNs.
 */
export function lastBucketsOf(
  usage: TokenUsageStateLike | undefined,
): { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined {
  const buckets = usage?.last?.buckets
  const input = buckets?.uncachedInputTokens ?? buckets?.inputTokens
  if (typeof input !== 'number' || !Number.isFinite(input)) return undefined
  if (typeof buckets?.outputTokens !== 'number' || !Number.isFinite(buckets.outputTokens)) return undefined
  return {
    inputTokens: input,
    outputTokens: buckets.outputTokens,
    ...typeof buckets.cacheReadTokens === 'number' && Number.isFinite(buckets.cacheReadTokens)
      ? { cacheReadTokens: buckets.cacheReadTokens }
      : {},
    ...typeof buckets.cacheWriteTokens === 'number' && Number.isFinite(buckets.cacheWriteTokens)
      ? { cacheWriteTokens: buckets.cacheWriteTokens }
      : {},
  }
}


/**
 * Map a `todos` projection value (`TodoItem[] | null`) onto view items.
 * Non-arrays (including the pre-first-write `null`) map to undefined (no
 * strip); malformed entries inside an array are dropped defensively so one
 * bad item degrades to a shorter list instead of a crash.
 */
export function todosOf(value: unknown): readonly TodoItemView[] | undefined {
  if (!Array.isArray(value)) return undefined
  const views: TodoItemView[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const content = (item as { content?: unknown }).content
    const status = (item as { status?: unknown }).status
    if (typeof content !== 'string') continue
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
    views.push({ content, status })
  }
  return views
}

/** Structural equality for two optional todo lists. */
export function sameTodos(
  a: readonly TodoItemView[] | undefined,
  b: readonly TodoItemView[] | undefined,
): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a.length !== b.length) return false
  return a.every((item, i) => item.content === b[i]!.content && item.status === b[i]!.status)
}

/**
 * Raw context-window occupancy behind {@link percentOf}: the latest sample
 * plus the surface's movement since that sample was taken (the projection's
 * anchor adjustment), falling back to the bare sample when no anchor exists.
 * `window` is undefined — the result still being usable for exact-token
 * display — when the projection does not expose a positive window. Callers
 * must render from these raw counts, never back-derive them from the rounded
 * percent.
 */
export function occupancyOf(pressure: ContextPressureStateLike | undefined): { used: number; window?: number } | undefined {
  const sample = pressure?.pressureTokens
  if (typeof sample !== 'number') return undefined
  const { surfaceTokens, sampledSurfaceTokens } = pressure ?? {}
  const used = typeof surfaceTokens === 'number' && typeof sampledSurfaceTokens === 'number'
    ? Math.max(0, sample + surfaceTokens - sampledSurfaceTokens)
    : sample
  const contextWindow = pressure?.contextWindow
  const window = typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : undefined
  // exactOptionalPropertyTypes: `window` must be absent, not explicitly undefined.
  return window === undefined ? { used } : { used, window }
}

/**
 * Context-occupancy percent (0-100 int) from a `contextPressure` state
 * value. Undefined until both numerator and denominator are known.
 */
export function percentOf(pressure: ContextPressureStateLike | undefined): number | undefined {
  const occupancy = occupancyOf(pressure)
  if (occupancy === undefined || occupancy.window === undefined) return undefined
  return Math.max(0, Math.min(100, Math.round((occupancy.used / occupancy.window) * 100)))
}

/**
 * Map a `contextBreakdown` projection value onto the usage panel's three role
 * counts. Absent or malformed fields (shape drift, a partial value) degrade
 * to no breakdown — the panel renders the whole section `n/a` instead of a
 * misleading subset of numbers.
 */
export function breakdownOf(value: unknown): UsageBreakdownView | undefined {
  const raw = value as ContextBreakdownStateLike | null | undefined
  if (raw === null || typeof raw !== 'object') return undefined
  const { system, tools, messages } = raw
  if (typeof system !== 'number' || typeof tools !== 'number' || typeof messages !== 'number') {
    return undefined
  }
  return { system, tools, messages }
}

/**
 * Assemble the usage panel's view from the three projection reads. Absent
 * sections stay absent (the panel renders each `n/a` independently); an
 * all-absent read yields undefined so no empty snapshot is parked in state.
 */
export function usageViewOf(
  totals: TokenUsageTotals | undefined,
  occupancy: { used: number; window?: number } | undefined,
  breakdown: UsageBreakdownView | undefined,
): UsageView | undefined {
  const view: UsageView = {}
  if (totals !== undefined) view.totals = totals
  if (occupancy !== undefined) {
    view.contextUsed = occupancy.used
    if (occupancy.window !== undefined) view.contextWindow = occupancy.window
  }
  if (breakdown !== undefined) view.breakdown = breakdown
  const empty = view.totals === undefined && view.contextUsed === undefined && view.breakdown === undefined
  return empty ? undefined : view
}

/** Structural equality for two usage token-total sets. */
function sameTotals(a: UsageView['totals'], b: UsageView['totals']): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.input === b.input && a.output === b.output
    && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite
}

/** Structural equality for two usage breakdowns. */
export function sameBreakdown(a: UsageBreakdownView | undefined, b: UsageBreakdownView | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.system === b.system && a.tools === b.tools && a.messages === b.messages
}

/** Structural equality for two usage snapshots (all sections field-wise). */
export function sameUsage(a: UsageView | undefined, b: UsageView): boolean {
  return a !== undefined
    && sameTotals(a.totals, b.totals)
    && a.contextUsed === b.contextUsed
    && a.contextWindow === b.contextWindow
    && sameBreakdown(a.breakdown, b.breakdown)
}
