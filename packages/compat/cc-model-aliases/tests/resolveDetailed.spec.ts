import { describe, expect, it, vi } from 'vitest'
import { createModelResolver } from '@dsh-cc/model-aliases'
import type { DetailedRoute } from '@dsh-cc/model-aliases'
import type { AliasTarget } from '@dsh-cc/model-aliases'

/** Build a resolver over a static effective alias map (already merged). */
function resolverOf(aliases: Record<string, AliasTarget>, warn?: (m: string) => void) {
  return createModelResolver(
    () => new Map(Object.entries(aliases).map(([k, v]) => [k.toLowerCase(), v] as const)),
    warn ? { warn } : undefined,
  )
}

describe('resolveDetailed', () => {
  it('classifies undefined as inherit with no route', () => {
    const r = resolverOf({ haiku: { model: 'cheap' } })
    expect(r.resolveDetailed(undefined)).toEqual<DetailedRoute>({
      selector: undefined,
      via: 'inherit',
      route: undefined,
    })
  })

  it('classifies blank as inherit with no route', () => {
    const r = resolverOf({})
    expect(r.resolveDetailed('   ')).toEqual<DetailedRoute>({
      selector: undefined,
      via: 'inherit',
      route: undefined,
    })
  })

  it('classifies the explicit "inherit" sentinel as inherit', () => {
    const r = resolverOf({ inherit: { model: 'x' } })
    expect(r.resolveDetailed('inherit')).toEqual<DetailedRoute>({
      selector: 'inherit',
      via: 'inherit',
      route: undefined,
    })
  })

  it('classifies a configured alias and returns its route', () => {
    const r = resolverOf({ haiku: { provider: 'p', model: 'cheap' } })
    expect(r.resolveDetailed('haiku')).toEqual<DetailedRoute>({
      selector: 'haiku',
      via: 'alias',
      route: { provider: 'p', model: 'cheap' },
    })
  })

  it('classifies a string-form alias target as alias with {model} route', () => {
    const r = resolverOf({ haiku: 'deepseek-chat' })
    expect(r.resolveDetailed('haiku')).toEqual<DetailedRoute>({
      selector: 'haiku',
      via: 'alias',
      route: { model: 'deepseek-chat' },
    })
  })

  it('classifies an unconfigured lane peer onto a configured CC peer as alias', () => {
    const r = resolverOf({ haiku: { model: 'cheap' } })
    expect(r.resolveDetailed('sketch')).toEqual<DetailedRoute>({
      selector: 'sketch',
      via: 'alias',
      route: { model: 'cheap' },
    })
  })

  it('classifies an unconfigured lane whose peer is also unconfigured as inherit', () => {
    const r = resolverOf({})
    expect(r.resolveDetailed('sketch')).toEqual<DetailedRoute>({
      selector: 'sketch',
      via: 'inherit',
      route: undefined,
    })
  })

  it('classifies an unconfigured builtin alias as inherit', () => {
    const r = resolverOf({})
    expect(r.resolveDetailed('opus')).toEqual<DetailedRoute>({
      selector: 'opus',
      via: 'inherit',
      route: undefined,
    })
  })

  it('classifies a custom unconfigured alias-looking word as literal (single-snapshot atomicity)', () => {
    const r = resolverOf({})
    const detailed = r.resolveDetailed('researcher')
    expect(detailed).toEqual<DetailedRoute>({
      selector: 'researcher',
      via: 'literal',
      route: { model: 'researcher' },
    })
  })

  it('warns on a custom unconfigured alias-looking word, same as resolve()', () => {
    const warn = vi.fn()
    const r = resolverOf({}, warn)
    r.resolveDetailed('researcher')
    r('researcher')
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('classifies a literal model id as literal without warning', () => {
    const warn = vi.fn()
    const r = resolverOf({}, warn)
    expect(r.resolveDetailed('deepseek-chat')).toEqual<DetailedRoute>({
      selector: 'deepseek-chat',
      via: 'literal',
      route: { model: 'deepseek-chat' },
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('routes agree with resolve() for shared inputs', () => {
    const r = resolverOf({ haiku: { provider: 'p', model: 'cheap' } })
    for (const model of [undefined, 'inherit', 'haiku', 'sketch', 'opus', 'researcher', 'deepseek-chat']) {
      expect(r.resolveDetailed(model).route).toEqual(r(model))
    }
  })
})
