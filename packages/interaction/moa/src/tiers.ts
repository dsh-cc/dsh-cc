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

/** Equality key for a resolved route (exact provider+model string match). */
function routeKey(route: ResolvedRoute): string {
  return `${route.provider ?? ''}\u0000${route.model ?? ''}`
}

/**
 * Resolve all four tiers via `modelRoutes.resolve` (which already follows
 * peers/inherit) and require FOUR DISTINCT resolved routes (§3.7
 * arming-time validation). A degenerate ladder is a validation failure, not
 * an exception: the caller warns once and refuses to arm.
 */
export function resolveTiers(modelRoutes: ModelRoutes): TierResolution {
  const tiers: ResolvedRoute[] = []
  const seen = new Map<string, string>()
  for (const alias of TIER_ALIASES) {
    const route = modelRoutes.resolve(alias)
    if (route === undefined || route.provider === undefined || route.model === undefined) {
      return { ok: false, reason: `moa tier "${alias}" does not resolve to a concrete route` }
    }
    const key = routeKey(route)
    const clash = seen.get(key)
    if (clash !== undefined) {
      return { ok: false, reason: `moa ladder is degenerate: "${clash}" and "${alias}" resolve to the same model` }
    }
    seen.set(key, alias)
    tiers.push(route)
  }
  return { ok: true, tiers }
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
