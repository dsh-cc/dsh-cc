/**
 * Pure tail-risk tier selection for context-routing v2 (design
 * docs/plans/2026-11-02-systemone-09-moa-context-routing.md §"Tier selection
 * and lifecycle").
 *
 * The policy answers one question over the four-label routing distribution:
 * which is the LOWEST capability tier whose probability mass above it is at
 * most `maxUnderTierProbability`? A confident argmax with a long upper tail
 * therefore still routes higher, which is the point of v2 — an under-tier
 * miss costs more than the tier step.
 *
 * No I/O, no cordis, no model access: the caller validates the decision
 * envelope first and folds adjacent same-route tiers afterwards with the
 * ladder snapshot (`collapseAppliedTier`), so this module returns the raw
 * index k over the ascending sketch..masterplan ladder.
 *
 * @module
 */

/** Boundary tolerance on the raw-double comparisons (design §"Tier selection"). */
const TOLERANCE = 1e-12

/** Ascending capability ladder labels, exactly as they arrive on the wire. */
export const ROUTING_TIER_LABELS = ['sketch', 'draft', 'blueprint', 'masterplan'] as const

/** One label of the four-tier routing distribution. */
export type RoutingTierLabel = (typeof ROUTING_TIER_LABELS)[number]

/** The selected tier index on the ascending ladder. */
export type RoutingTierIndex = 0 | 1 | 2 | 3

/** Input of {@link chooseRoutingTier}. */
export interface ChooseRoutingTierInput {
  /** Per-label probabilities as returned by the decision runtime. */
  probabilities: Record<RoutingTierLabel, number>
  /** Maximum tolerated probability mass strictly above the selected tier. */
  maxUnderTierProbability: number
  /** Below this top probability no tier is defensible: fall back to live. */
  minTopProbability: number
}

/**
 * Select the raw tier index, or `undefined` when the distribution cannot be
 * classified (a label is missing or non-finite) or when the top probability
 * does not clear `minTopProbability`.
 *
 * Semantics: compute maxP; `maxP + TOLERANCE < minTopProbability` ⇒
 * `undefined`. Otherwise return the first k in 0..3 whose upper tail
 * `sum(p[j], j > k)` is `<= maxUnderTierProbability + TOLERANCE`. The tail at
 * k = 3 is empty, so a result always exists once the maxP gate passes.
 */
export function chooseRoutingTier(input: ChooseRoutingTierInput): RoutingTierIndex | undefined {
  // Every label must carry a finite probability; a partial distribution is a
  // S1-01 validation failure, never an implicit zero.
  const probabilities: number[] = []
  for (const label of ROUTING_TIER_LABELS) {
    const p = input.probabilities[label]
    if (typeof p !== 'number' || !Number.isFinite(p)) return undefined
    probabilities.push(p)
  }
  let maxProbability = -Infinity
  for (const p of probabilities) {
    if (p > maxProbability) maxProbability = p
  }
  if (maxProbability + TOLERANCE < input.minTopProbability) return undefined
  // Tails[k] = probability mass strictly above tier k (tails[3] is empty).
  const tails: number[] = [0, 0, 0, 0]
  for (let k = 2; k >= 0; k -= 1) tails[k] = tails[k + 1]! + probabilities[k + 1]!
  for (let k = 0; k <= 3; k += 1) {
    if (tails[k]! <= input.maxUnderTierProbability + TOLERANCE) return k as RoutingTierIndex
  }
  // Unreachable: the k = 3 tail is 0 and therefore always satisfies a
  // non-negative bound. Present only so the signature stays total.
  return 3
}
