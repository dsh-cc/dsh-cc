/**
 * Tier ladder (design §3.1/§3.7): the four lane aliases in ascending
 * capability, resolved through the `ModelRoutes` service at arming time.
 * Unconfigured lanes follow the peer chain (inherit) — a fully-inherited
 * ladder is trivially degenerate, and the distinctness check refuses to arm
 * on it (aliases alone guarantee neither capability nor cost ordering).
 *
 * @module
 */

import type { ResolvedRoute } from '@dsh-cc/model-aliases'
import type { ModelRoutes } from '@dsh-cc/model-aliases'

/** The four lane aliases, ascending capability (resolver.ts LANE_PEERS). */
export const TIER_ALIASES: readonly string[] = ['sketch', 'draft', 'blueprint', 'masterplan']

/** Number of tiers; `masterplan` (index 3) is the hard ceiling. */
export const TIER_COUNT = TIER_ALIASES.length

/** Either a resolved ladder or a validation failure (never throws). */
export type TierResolution =
  | { ok: true; tiers: readonly ResolvedRoute[] }
  | { ok: false; reason: string }

/** A resolved ladder snapshot (`resolveTiers` output, §3.2.4). */
export type TierLadder = readonly ResolvedRoute[]

/** Equality key for a resolved route (exact provider+model string match). */
function routeKey(route: ResolvedRoute): string {
  return `${route.provider ?? ''}\u0000${route.model ?? ''}`
}

/** Operator-facing ladder table for a refusal message (§3.1). */
function ladderTable(tiers: readonly ResolvedRoute[]): string {
  return tiers
    .map((route, index) => `${TIER_ALIASES[index] ?? index}→${route.provider ?? ''}/${route.model ?? ''}`)
    .join(', ')
}

/**
 * Resolve all four tiers via `modelRoutes.resolve` (which already follows
 * peers/inherit) and require CONTIGUOUS RUNS with at least two distinct
 * routes (§3.1 arming validation): a model may repeat only adjacent to
 * itself (`[A,A,B,C]` arms); a reappearance after a different model
 * (`[A,B,A,C]`) would let `nextDistinctTier` hop DOWN to a cheaper model,
 * so it refuses. All-identical ladders refuse too. A failure is a
 * validation result, not an exception: the caller warns once and refuses to
 * arm.
 */
export function resolveTiers(modelRoutes: ModelRoutes): TierResolution {
  const tiers: ResolvedRoute[] = []
  for (const alias of TIER_ALIASES) {
    const route = modelRoutes.resolve(alias)
    if (route === undefined || route.provider === undefined || route.model === undefined) {
      return { ok: false, reason: `moa tier "${alias}" does not resolve to a concrete route` }
    }
    tiers.push(route)
  }
  const seen = new Map<string, string>()
  for (const [index, alias] of TIER_ALIASES.entries()) {
    const route = tiers[index]
    if (route === undefined) continue
    const key = routeKey(route)
    const previous = index === 0 ? undefined : tiers[index - 1]
    const clash = previous !== undefined && routeKey(previous) === key ? undefined : seen.get(key)
    if (clash !== undefined) {
      return {
        ok: false,
        reason: `moa ladder is degenerate: "${clash}" and "${alias}" resolve to the same model non-contiguously (${ladderTable(tiers)})`,
      }
    }
    seen.set(key, alias)
  }
  if (seen.size < 2) {
    return { ok: false, reason: `moa ladder is degenerate: all tiers resolve to the same model (${ladderTable(tiers)})` }
  }
  return { ok: true, tiers }
}

/**
 * The next tier index ABOVE `fromTier` whose resolved route differs from the
 * current tier's (§3.2): same-model rungs are skipped, never re-rolled.
 * Returns undefined at the top or when no distinct tier remains above.
 */
export function nextDistinctTier(fromTier: number, ladder: TierLadder | undefined): number | undefined {
  if (ladder === undefined || !Number.isInteger(fromTier) || fromTier < 0 || fromTier >= ladder.length) return undefined
  const from = ladder[fromTier]
  if (from === undefined) return undefined
  const fromKey = routeKey(from)
  for (let index = fromTier + 1; index < ladder.length; index++) {
    const route = ladder[index]
    if (route !== undefined && routeKey(route) !== fromKey) return index
  }
  return undefined
}

/**
 * The applied tier index (§3.3): collapse to the FIRST index of the
 * contiguous same-model run, so a same-model argmax flip changes neither the
 * applied model, the status label, nor the bookkeeping floor gap.
 */
export function collapseAppliedTier(tier: number, ladder: TierLadder | undefined): number {
  if (ladder === undefined || !Number.isInteger(tier) || tier < 0 || tier >= ladder.length) return tier
  const route = ladder[tier]
  if (route === undefined) return tier
  const key = routeKey(route)
  let first = tier
  while (first > 0) {
    const previous = ladder[first - 1]
    if (previous === undefined || routeKey(previous) !== key) break
    first--
  }
  return first
}

/**
 * Runtime ladder view (§3.2.4): the arming-time snapshot, or a live
 * re-resolution as the per-firing fail-open path when the snapshot is absent.
 */
export function ladderSnapshot(snapshot: TierLadder | undefined, routes: ModelRoutes | undefined): TierLadder | undefined {
  if (snapshot !== undefined) return snapshot
  if (routes === undefined) return undefined
  const resolved = resolveTiers(routes)
  return resolved.ok ? resolved.tiers : undefined
}

/** The tier alias at `index` (0-based), or undefined out of range. */
export function tierAt(index: number): string | undefined {
  return TIER_ALIASES[index]
}

/**
 * The next tier up from `currentTier` (0-based index). `masterplan` is the
 * hard ceiling: the result never exceeds `TIER_COUNT - 1`, regardless of
 * `ceiling`. Out-of-range current clamps to the top.
 */
export function nextTierUp(currentTier: number, ceiling: number = Number.MAX_SAFE_INTEGER): number {
  return Math.min(currentTier + 1, TIER_COUNT - 1, ceiling)
}
