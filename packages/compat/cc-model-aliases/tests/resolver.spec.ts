/**
 * Unit tests for the cc-model-aliases resolver and merge semantics: lookup
 * order (settings → config → builtin fallback), inherit, case-insensitive key
 * matching, null deletion, entry-shallow merge (no field blending), builtin
 * fallback, and literal passthrough with warn.
 */
import { describe, expect, it } from 'vitest'
import { createModelInspector, createModelResolver, mergeAliasMaps, BUILTIN_ALIASES } from '../src/resolver.ts'
import { ConfigAliasesSchema, SettingsAliasesSchema } from '../src/schema.ts'
import type { AliasTarget } from '../src/types.ts'
import type { ResolvedRoute } from '../src/types.ts'

/** Build a resolver whose alias source is a fixed (call-time) map. */
function resolverFor(
  config: Record<string, unknown> | undefined,
  settings: Record<string, unknown> | null | undefined,
): { resolve: (model: string | undefined) => ResolvedRoute | undefined; warns: string[] } {
  const warns: string[] = []
  const resolve = createModelResolver(
    () => mergeAliasMaps(config as never, settings as never),
    { warn: message => warns.push(message) },
  )
  return { resolve, warns }
}

/** Build an inspector whose alias source is a fixed (call-time) map. */
function inspectorFor(
  config: Record<string, unknown> | undefined,
  settings: Record<string, unknown> | null | undefined,
): { inspect: (model: string | undefined) => ReturnType<ReturnType<typeof createModelInspector>>; resolve: (model: string | undefined) => ResolvedRoute | undefined; warns: string[] } {
  const warns: string[] = []
  const inspect = createModelInspector(
    () => mergeAliasMaps(config as never, settings as never),
    { warn: message => warns.push(message) },
  )
  return { inspect, resolve: (model) => inspect(model).route, warns }
}

describe('mergeAliasMaps', () => {
  it('folds alias keys to lowercase across both layers', () => {
    const merged = mergeAliasMaps(
      { Sonnet: 'sf' },
      { sONNET: { provider: 'p', model: 'm' } },
    )
    const folded = Object.fromEntries(merged)
    expect(folded).toEqual({ sonnet: { provider: 'p', model: 'm' } })
  })

  it('settings entry replaces config entry wholesale, never field-merging', () => {
    const merged = mergeAliasMaps(
      { opus: { provider: 'A', model: 'X' } },
      { opus: { model: 'Y' } },
    )
    // The settings `{ provider: undefined, model: Y }`-shape object wins whole;
    // provider must NOT survive from config as a blended `{ provider: A, model: Y }`.
    expect(Object.fromEntries(merged)['opus']).toEqual({ model: 'Y' })
  })

  it('settings null deletes a configured config entry', () => {
    const merged = mergeAliasMaps(
      { sonnet: 'sf', opus: { provider: 'p', model: 'm' } },
      { sonnet: null },
    )
    const folded = Object.fromEntries(merged)
    expect(folded).toEqual({ opus: { provider: 'p', model: 'm' } })
  })

  it('config-only aliases survive when settings provided no competing key', () => {
    const merged = mergeAliasMaps({ turbo: 't' }, { sonnet: 's' })
    const folded = Object.fromEntries(merged)
    expect(folded).toEqual({ turbo: 't', sonnet: 's' })
  })

  it('undefined layers yield an empty map', () => {
    expect(mergeAliasMaps(undefined, undefined).size).toBe(0)
  })
})

describe('createModelResolver lookup order', () => {
  it('settings alias wins over config alias', () => {
    const { resolve } = resolverFor({ sonnet: 'cfg' }, { sonnet: 'set' })
    expect(resolve('sonnet')).toEqual({ model: 'set' })
  })

  it('config alias is used when settings have none', () => {
    const { resolve } = resolverFor({ sonnet: 'cfg' }, {})
    expect(resolve('sonnet')).toEqual({ model: 'cfg' })
  })

  it('alias key matching is case-insensitive', () => {
    const { resolve } = resolverFor({ Sonnet: 'sf' }, {})
    expect(resolve('SONNET')).toEqual({ model: 'sf' })
    expect(resolve('sonnet')).toEqual({ model: 'sf' })
  })

  it('string-form alias resolves to model-only route', () => {
    const { resolve } = resolverFor({ opus: 'deepseek-pro' }, {})
    expect(resolve('opus')).toEqual({ model: 'deepseek-pro' })
  })

  it('object-form alias resolves to explicit provider+model route', () => {
    const { resolve } = resolverFor({}, { opus: { provider: 'anthropic', model: 'claude-opus' } })
    expect(resolve('opus')).toEqual({ provider: 'anthropic', model: 'claude-opus' })
  })

  it('live settings read is fresh on every invocation (liveness, not a snapshot)', () => {
    let settings: Record<string, string> = { sonnet: 'v1' }
    const warns: string[] = []
    const resolve = createModelResolver(
      () => mergeAliasMaps({}, settings),
      { warn: m => warns.push(m) },
    )
    expect(resolve('sonnet')).toEqual({ model: 'v1' })
    settings = { sonnet: 'v2' }
    expect(resolve('sonnet')).toEqual({ model: 'v2' })
    expect(warns).toEqual([])
  })
})

describe('createModelResolver inherit / builtin fallback / passthrough', () => {
  it('undefined model resolves to undefined (no override)', () => {
    const { resolve } = resolverFor({}, {})
    expect(resolve(undefined)).toBeUndefined()
    expect(resolve('  ')).toBeUndefined()
  })

  it('inherit resolves to undefined (case-insensitive), fixing the pass-through bug', () => {
    const { resolve } = resolverFor({}, {})
    expect(resolve('inherit')).toBeUndefined()
    expect(resolve('Inherit')).toBeUndefined()
    expect(resolve('INHERIT')).toBeUndefined()
  })

  it('unconfigured builtin alias falls back to inherit (undefined)', () => {
    const { resolve } = resolverFor({}, {})
    for (const alias of ['fable', 'opus', 'sonnet', 'haiku', 'architect']) {
      expect(resolve(alias)).toBeUndefined()
    }
    // Case-insensitive builtin match.
    expect(resolve('OPUS')).toBeUndefined()
  })

  it('unconfigured lane follows its CC peer route', () => {
    const { resolve } = resolverFor({ haiku: 'flash', sonnet: 'balanced', opus: 'deep', fable: 'max' }, {})
    expect(resolve('sketch')).toEqual({ model: 'flash' })
    expect(resolve('draft')).toEqual({ model: 'balanced' })
    expect(resolve('blueprint')).toEqual({ model: 'deep' })
    expect(resolve('masterplan')).toEqual({ model: 'max' })
    expect(resolve('architect')).toBeUndefined()
  })

  it('unconfigured lane inherits when its CC peer is also unconfigured', () => {
    const { resolve } = resolverFor({}, {})
    expect(resolve('sketch')).toBeUndefined()
    expect(resolve('draft')).toBeUndefined()
    expect(resolve('blueprint')).toBeUndefined()
    expect(resolve('masterplan')).toBeUndefined()
  })

  it('configured string-form lane follows one hop to another alias', () => {
    const { resolve } = resolverFor({ haiku: { provider: 'p', model: 'flash', reasoningEffort: 'low' }, sketch: 'haiku' }, {})
    expect(resolve('sketch')).toEqual({ provider: 'p', model: 'flash', reasoningEffort: 'low' })
  })

  it('configured string-form lane to inherit inherits; to a literal id stays a literal', () => {
    const { resolve } = resolverFor({ sketch: 'inherit', draft: 'deepseek-chat' }, {})
    expect(resolve('sketch')).toBeUndefined()
    expect(resolve('draft')).toEqual({ model: 'deepseek-chat' })
  })

  it('does not follow a second hop (cycle-safe)', () => {
    const { resolve } = resolverFor({ sketch: 'draft', draft: 'haiku', haiku: 'flash' }, {})
    // sketch → draft (string) stops; "haiku" is returned as a literal model id.
    expect(resolve('sketch')).toEqual({ model: 'haiku' })
  })

  it('a null-deleted builtin alias still falls back to inherit (no error state)', () => {
    // settings deletes a config entry for a builtin; the map has no entry, so
    // the builtin fallback (inherit) applies.
    const { resolve } = resolverFor({ opus: 'cfg' }, { opus: null })
    expect(resolve('opus')).toBeUndefined()
  })

  it('custom unconfigured alias passes through verbatim and warns', () => {
    const { resolve, warns } = resolverFor({}, {})
    expect(resolve('turbo')).toEqual({ model: 'turbo' })
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/turbo/)
  })

  it('literal model id with punctuation passes through verbatim without warning', () => {
    const { resolve, warns } = resolverFor({}, {})
    expect(resolve('deepseek-chat')).toEqual({ model: 'deepseek-chat' })
    expect(warns).toEqual([])
  })

  it('BUILTIN_ALIASES lists the CC family plus dsh-cc lanes', () => {
    expect([...BUILTIN_ALIASES].sort()).toEqual([
      'architect', 'blueprint', 'draft', 'fable', 'gauge', 'haiku', 'masterplan', 'opus', 'sketch', 'sonnet',
    ])
  })

  it('unconfigured gauge follows its haiku peer route (via peer)', () => {
    const { resolve } = resolverFor({ haiku: { provider: 'p', model: 'flash' } }, {})
    expect(resolve('gauge')).toEqual({ provider: 'p', model: 'flash' })
    const { inspect } = inspectorFor({ haiku: { provider: 'p', model: 'flash' } }, {})
    const inspection = inspect('gauge')
    expect(inspection.kind).toBe('route')
    expect(inspection.via).toBe('peer')
    expect(inspection.hop).toBe('haiku')
    expect(inspection.route).toEqual(inspect('haiku').route)
  })

  it('unconfigured gauge inherits when haiku is also unconfigured', () => {
    const { resolve } = resolverFor({}, {})
    expect(resolve('gauge')).toBeUndefined()
  })

  it('configured object-form gauge wins and keeps the System One protocol marker on the route', () => {
    const { resolve } = resolverFor(
      { haiku: 'flash' },
      { gauge: { provider: 'orchestrix', model: 'llmbox_systemone/laya', protocol: 'systemone' } },
    )
    expect(resolve('gauge')).toEqual({ provider: 'orchestrix', model: 'llmbox_systemone/laya', protocol: 'systemone' })
  })

  it('gauge$high strips the level suffix like other lane aliases', () => {
    const { resolve } = resolverFor({ haiku: { provider: 'p', model: 'flash' } }, {})
    // The suffix becomes a stamped reasoningEffort on the peer route, not a literal lookup.
    expect(resolve('gauge$high')).toEqual({ provider: 'p', model: 'flash', reasoningEffort: 'high' })
  })

  it('schemas accept {provider, model} without protocol in both layers', () => {
    expect(() => ConfigAliasesSchema({ gauge: { provider: 'p', model: 'm' } } as never)).not.toThrow()
    expect(() => SettingsAliasesSchema({ gauge: { provider: 'p', model: 'm' } } as never)).not.toThrow()
  })

  it('mergeAliasMaps round-trips an entry carrying protocol', () => {
    const merged = mergeAliasMaps(
      {},
      { gauge: { provider: 'orchestrix', model: 'llmbox_systemone/laya', protocol: 'systemone' } },
    )
    expect(Object.fromEntries(merged)['gauge']).toEqual({
      provider: 'orchestrix', model: 'llmbox_systemone/laya', protocol: 'systemone',
    })
  })
})

describe('schema and defensive robustness', () => {
  it('schemas accept the documented shapes', () => {
    const cfg = (v: unknown): Record<string, AliasTarget> => ConfigAliasesSchema(v as never)
    const set = (v: unknown): Record<string, AliasTarget | null> => SettingsAliasesSchema(v as never)
    expect(() => cfg({ opus: { provider: 'p', model: 'm' } })).not.toThrow()
    expect(() => cfg({ sonnet: 's' })).not.toThrow()
    expect(() => set({ sonnet: null })).not.toThrow()
    expect(() => set({ opus: { provider: 'p', model: 'm' } })).not.toThrow()
    // A blank string target is rejected (union string branch min(1) fails).
    expect(() => cfg({ sonnet: '' })).toThrow()
  })

  it('config null is treated as absent (schemastery dicts are lenient at validation)', () => {
    const merged = mergeAliasMaps({ opus: null } as never, {})
    expect(merged.has('opus')).toBe(false)
    const { resolve } = resolverFor({ opus: null } as never, {})
    expect(resolve('opus')).toBeUndefined()
  })
})

describe('reasoningEffort on object-form aliases', () => {
  it('object form with effort resolves to all three fields', () => {
    const { resolve } = resolverFor({}, {
      opus: { provider: 'orchestrix', model: 'glm-5.3', reasoningEffort: 'max' },
    })
    expect(resolve('opus')).toEqual({ provider: 'orchestrix', model: 'glm-5.3', reasoningEffort: 'max' })
  })

  it('empty reasoningEffort is schema-rejected in both layers', () => {
    expect(() => ConfigAliasesSchema({ opus: { provider: 'p', model: 'm', reasoningEffort: '' } } as never)).toThrow()
    expect(() => SettingsAliasesSchema({ opus: { provider: 'p', model: 'm', reasoningEffort: '' } } as never)).toThrow()
  })

  it('object form without effort resolves without an effort key', () => {
    const { resolve } = resolverFor({}, { opus: { provider: 'p', model: 'm' } })
    expect(resolve('opus')).toEqual({ provider: 'p', model: 'm' })
    expect(resolve('opus')).not.toHaveProperty('reasoningEffort')
  })

  it('string form never carries effort even when a sibling alias does', () => {
    const { resolve } = resolverFor({}, {
      opus: { provider: 'p', model: 'm', reasoningEffort: 'max' },
      sonnet: 'glm-5.3-flash',
    })
    expect(resolve('sonnet')).toEqual({ model: 'glm-5.3-flash' })
    expect(resolve('sonnet')).not.toHaveProperty('reasoningEffort')
  })

  it('inherit and unconfigured builtin still resolve to undefined (no stamp)', () => {
    const { resolve } = resolverFor({ opus: { provider: 'p', model: 'm', reasoningEffort: 'max' } }, {})
    expect(resolve('inherit')).toBeUndefined()
    expect(resolve('haiku')).toBeUndefined()
  })

  it('settings string-form replaces a config object wholesale and drops its effort', () => {
    const { resolve } = resolverFor(
      { opus: { provider: 'p', model: 'm', reasoningEffort: 'max' } },
      { opus: 'glm-x' },
    )
    expect(resolve('opus')).toEqual({ model: 'glm-x' })
    expect(resolve('opus')).not.toHaveProperty('reasoningEffort')
  })

  it('object form with optional provider omitted stamps effort while inheriting provider', () => {
    const { resolve } = resolverFor({}, { sonnet: { model: 'glm-5.3-flash', reasoningEffort: 'max' } })
    expect(resolve('sonnet')).toEqual({ model: 'glm-5.3-flash', reasoningEffort: 'max' })
    expect(resolve('sonnet')).not.toHaveProperty('provider')
  })

  it('object form without model passes the schema but is rejected at the service write-time validate', () => {
    // schemastery object fields cannot express presence in this version (field
    // `.required()` throws even when present), so presence is the service
    // validate's cross-field job — the same place blank provider/model is
    // already rejected. The resolver stays lenient and forwards what is there.
    expect(() => ConfigAliasesSchema({ opus: { provider: 'p', reasoningEffort: 'max' } } as never)).not.toThrow()
    const { resolve } = resolverFor({}, { opus: { provider: 'p', reasoningEffort: 'max' } })
    expect(resolve('opus')).toEqual({ provider: 'p', reasoningEffort: 'max' })
  })
})

describe('createModelInspector provenance', () => {
  it('configured object alias inspects as route/configured and matches resolve', () => {
    const { inspect, resolve } = inspectorFor({ opus: { provider: 'p', model: 'm', reasoningEffort: 'max' } }, {})
    const inspection = inspect('opus')
    expect(inspection.kind).toBe('route')
    expect(inspection.via).toBe('configured')
    expect(inspection.route).toEqual(resolve('opus'))
  })

  it('null-deleted config entry inspects as inherit, same as unconfigured', () => {
    const { inspect } = inspectorFor({ opus: 'cfg' }, { opus: null })
    expect(inspect('opus')).toEqual({ kind: 'inherit', via: 'builtin' })
    const { inspect: bare } = inspectorFor({}, {})
    expect(inspect('opus')).toEqual(bare('opus'))
  })

  it('unconfigured lane follows its peer: via peer with the peer hop', () => {
    const { inspect } = inspectorFor({ haiku: { provider: 'p', model: 'flash' } }, {})
    const inspection = inspect('sketch')
    expect(inspection.kind).toBe('route')
    expect(inspection.via).toBe('peer')
    expect(inspection.hop).toBe('haiku')
    expect(inspection.route).toEqual(inspect('haiku').route)
  })

  it('configured string-form target inspects as one-hop with the folded target', () => {
    const { inspect } = inspectorFor({ sketch: 'haiku', haiku: { provider: 'p', model: 'flash' } }, {})
    const inspection = inspect('sketch')
    expect(inspection.kind).toBe('route')
    expect(inspection.via).toBe('one-hop')
    expect(inspection.hop).toBe('haiku')
    expect(inspection.route).toEqual({ provider: 'p', model: 'flash' })
  })

  it('one-hop string target to an unconfigured builtin inspects as inherit', () => {
    const { inspect } = inspectorFor({ sketch: 'haiku' }, {})
    expect(inspect('sketch')).toEqual({ kind: 'inherit', via: 'one-hop', hop: 'haiku' })
  })

  it('unconfigured architect inspects as inherit/builtin', () => {
    const { inspect } = inspectorFor({}, {})
    expect(inspect('architect')).toEqual({ kind: 'inherit', via: 'builtin' })
  })

  it('inherit token inspects as inherit without via', () => {
    const { inspect } = inspectorFor({}, {})
    expect(inspect('inherit')).toEqual({ kind: 'inherit' })
    expect(inspect(undefined)).toEqual({ kind: 'inherit' })
  })

  it('inspect(x).route matches resolve(x) across the classification cases', () => {
    const cases: Array<[Record<string, unknown> | undefined, Record<string, unknown> | null | undefined, string | undefined]> = [
      [{ opus: { provider: 'p', model: 'm', reasoningEffort: 'max' } }, {}, 'opus'],
      [{ opus: 'cfg' }, { opus: null }, 'opus'],
      [{ haiku: { provider: 'p', model: 'flash' } }, {}, 'sketch'],
      [{ sketch: 'haiku', haiku: { provider: 'p', model: 'flash' } }, {}, 'sketch'],
      [{ sketch: 'inherit', draft: 'deepseek-chat' }, {}, 'sketch'],
      [{ sketch: 'inherit', draft: 'deepseek-chat' }, {}, 'draft'],
      [{}, {}, 'architect'],
      [{}, {}, 'inherit'],
      [{}, {}, 'turbo'],
      [{}, {}, 'deepseek-chat'],
      [{}, {}, undefined],
    ]
    for (const [config, settings, model] of cases) {
      const { inspect, resolve } = inspectorFor(config, settings)
      expect(inspect(model).route).toEqual(resolve(model))
    }
  })
})
