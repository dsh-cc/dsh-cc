import { describe, expect, it } from 'vitest'
import type { DetailedRoute, ModelRoutes, ResolvedRoute } from '@dsh-cc/model-aliases'
import { collapseAppliedTier, nextDistinctTier, nextTierUp, resolveTiers, TIER_ALIASES, TIER_COUNT, tierAt } from '../src/tiers.ts'

function routes(map: Record<string, ResolvedRoute | undefined>): ModelRoutes {
  return {
    resolve: (model) => (model === undefined ? undefined : map[model]),
    resolveDetailed: (model): DetailedRoute => ({ selector: model, via: 'alias', route: map[model ?? ''] }),
    inspect: () => {
      throw new Error('unused')
    },
  } as unknown as ModelRoutes
}

const route = (model: string): ResolvedRoute => ({ provider: 'p', model })

describe('tier ladder (§3.7)', () => {
  it('a distinct ladder passes validation', () => {
    const out = resolveTiers(routes({ sketch: route('haiku'), draft: route('sonnet'), blueprint: route('opus'), masterplan: route('fable') }))
    expect(out).toEqual({ ok: true, tiers: [route('haiku'), route('sonnet'), route('opus'), route('fable')] })
  })

  it('a contiguous same-model run arms (§3.1 [A,A,B,C])', () => {
    const out = resolveTiers(routes({ sketch: route('haiku'), draft: route('haiku'), blueprint: route('opus'), masterplan: route('fable') }))
    expect(out.ok).toBe(true)
  })

  it('a duplicated top rung arms (§3.1 [A,B,C,C])', () => {
    const out = resolveTiers(routes({ sketch: route('haiku'), draft: route('sonnet'), blueprint: route('opus'), masterplan: route('opus') }))
    expect(out.ok).toBe(true)
  })

  it('a non-contiguous reappearance fails validation (§3.1 [A,B,A,C])', () => {
    const out = resolveTiers(routes({ sketch: route('haiku'), draft: route('sonnet'), blueprint: route('haiku'), masterplan: route('fable') }))
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.reason).toContain('non-contiguously')
      expect(out.reason).toContain('sketch→p/haiku') // the resolved ladder table
    }
  })

  it('an all-identical ladder fails validation with the resolved table', () => {
    const out = resolveTiers(routes({ sketch: route('same'), draft: route('same'), blueprint: route('same'), masterplan: route('same') }))
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.reason).toContain('degenerate')
      expect(out.reason).toContain('sketch→p/same')
    }
  })

  it('inherit-only ladder fails validation (peer chain resolves to undefined without configuration)', () => {
    const out = resolveTiers(routes({}))
    expect(out.ok).toBe(false)
  })

  it('an unresolvable tier fails validation without throwing', () => {
    const out = resolveTiers(routes({ sketch: route('haiku'), draft: undefined, blueprint: route('opus'), masterplan: route('fable') }))
    expect(out.ok).toBe(false)
  })

  it('tierAt and TIER_COUNT expose the ascending ladder', () => {
    expect(TIER_COUNT).toBe(4)
    expect(TIER_ALIASES).toEqual(['sketch', 'draft', 'blueprint', 'masterplan'])
    expect(tierAt(0)).toBe('sketch')
    expect(tierAt(3)).toBe('masterplan')
    expect(tierAt(4)).toBeUndefined()
  })

  it('nextTierUp clamps at masterplan regardless of ceiling', () => {
    expect(nextTierUp(0)).toBe(1)
    expect(nextTierUp(2, 3)).toBe(3)
    expect(nextTierUp(3, 3)).toBe(3)
    expect(nextTierUp(0, 0)).toBe(0)
    expect(nextTierUp(9)).toBe(3)
  })
})

describe('distinct-tier escalation (§3.2)', () => {
  const ladder = [route('a'), route('a'), route('b'), route('b')]

  it('nextDistinctTier skips same-model rungs and never hops down', () => {
    expect(nextDistinctTier(0, ladder)).toBe(2)
    expect(nextDistinctTier(1, ladder)).toBe(2)
    expect(nextDistinctTier(2, ladder)).toBeUndefined() // duplicated top rung
    expect(nextDistinctTier(3, ladder)).toBeUndefined()
    expect(nextDistinctTier(-1, ladder)).toBeUndefined()
    expect(nextDistinctTier(0, undefined)).toBeUndefined()
  })

  it('nextDistinctTier on a fully distinct ladder is the next rung', () => {
    expect(nextDistinctTier(1, [route('a'), route('b'), route('c'), route('d')])).toBe(2)
  })

  it('collapseAppliedTier maps a same-model argmax to the first run index (§3.3)', () => {
    expect(collapseAppliedTier(1, ladder)).toBe(0)
    expect(collapseAppliedTier(3, ladder)).toBe(2)
    expect(collapseAppliedTier(2, ladder)).toBe(2)
    expect(collapseAppliedTier(1, undefined)).toBe(1)
  })
})
