import { describe, expect, it } from 'vitest'
import { chooseRoutingTier, ROUTING_TIER_LABELS, type RoutingTierLabel } from '../src/routing-policy.ts'

/** Ship defaults of the routing section (0.10 under-tier, 0.60 top). */
const DEFAULTS = { maxUnderTierProbability: 0.1, minTopProbability: 0.6 }

function distribution(values: readonly [number, number, number, number]): Record<RoutingTierLabel, number> {
  return { sketch: values[0], draft: values[1], blueprint: values[2], masterplan: values[3] }
}

describe('tail-risk tier selection (design §"Tier selection and lifecycle")', () => {
  it('the pinned complex distribution selects blueprint', () => {
    // sketch tail 0.35, draft tail 0.15, blueprint tail 0.05.
    expect(chooseRoutingTier({ probabilities: distribution([0.65, 0.2, 0.1, 0.05]), ...DEFAULTS })).toBe(2)
  })

  it('the pinned flat distribution falls back to live instead of forcing masterplan', () => {
    // maxP 0.28 is below min-top-probability 0.60.
    expect(chooseRoutingTier({ probabilities: distribution([0.28, 0.27, 0.25, 0.2]), ...DEFAULTS })).toBeUndefined()
  })

  it('a confident sketch with a short tail selects the lowest tier', () => {
    expect(chooseRoutingTier({ probabilities: distribution([0.95, 0.02, 0.02, 0.01]), ...DEFAULTS })).toBe(0)
  })

  it('a tail exactly at the bound is satisfied', () => {
    // draft tail is exactly 0.2 == maxUnderTierProbability.
    expect(chooseRoutingTier({ probabilities: distribution([0.6, 0.3, 0.1, 0]), ...DEFAULTS })).toBe(1)
  })

  it('a top probability exactly at min-top-probability proceeds', () => {
    // maxP is exactly 0.60: the gate passes, and draft has an empty tail.
    expect(chooseRoutingTier({ probabilities: distribution([0.6, 0.4, 0, 0]), ...DEFAULTS })).toBe(1)
  })

  it('a tail just past the bound is not tolerated but the next tier is', () => {
    expect(chooseRoutingTier({ probabilities: distribution([0.6, 0.3, 0.1 + 1e-6, 0]), ...DEFAULTS })).toBe(2)
  })

  it('a tail within the 1e-12 tolerance still satisfies the bound', () => {
    expect(chooseRoutingTier({ probabilities: distribution([0.6, 0.3, 0.1 + 1e-13, 0]), ...DEFAULTS })).toBe(1)
  })

  it('masterplan always satisfies once the top gate passes', () => {
    // Every tail above masterplan is empty; a 0.0 bound still lands on k = 3.
    expect(
      chooseRoutingTier({
        probabilities: distribution([0.26, 0.25, 0.25, 0.24]),
        maxUnderTierProbability: 0,
        minTopProbability: 0.25,
      }),
    ).toBe(3)
  })

  it('a missing label is undefined (no implicit zero)', () => {
    const partial = { sketch: 0.65, draft: 0.2, blueprint: 0.1 } as unknown as Record<RoutingTierLabel, number>
    expect(chooseRoutingTier({ probabilities: partial, ...DEFAULTS })).toBeUndefined()
  })

  it('a non-finite label is undefined', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(chooseRoutingTier({ probabilities: distribution([0.65, 0.2, bad, 0.05]), ...DEFAULTS })).toBeUndefined()
    }
  })

  it('exposes the ascending wire labels', () => {
    expect(ROUTING_TIER_LABELS).toEqual(['sketch', 'draft', 'blueprint', 'masterplan'])
  })
})
