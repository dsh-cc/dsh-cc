import { describe, expect, it } from 'vitest'
import type { DetailedRoute, ModelRoutes, ResolvedRoute } from '@dsh-cc/model-aliases'
import { nextTierUp, resolveTiers, TIER_ALIASES, TIER_COUNT, tierAt } from '../src/tiers.ts'

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

  it('two tiers sharing a model fails validation (degenerate ladder)', () => {
    const out = resolveTiers(routes({ sketch: route('haiku'), draft: route('haiku'), blueprint: route('opus'), masterplan: route('fable') }))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('degenerate')
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
