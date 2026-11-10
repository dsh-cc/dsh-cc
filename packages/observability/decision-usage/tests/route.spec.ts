/**
 * Route-resolution unit tests (design §"Public interface", C1/C3): the alias
 * IS the route (no capability table, no capability row, no peer fallback), the
 * per-alias pin row only narrows it, absent fields fall back to
 * registry-derived defaults, and an invalid present field disables THAT alias
 * alone. All fail-closed paths are pinned here.
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_GAUGE_CONTEXT_WINDOW } from '@dsh-cc/systemone'
import {
  DEFAULT_DECISION_MAX_OUTPUT_TOKENS,
  DEFAULT_DECISION_MAX_QUESTIONS,
  createWarnOnce,
  lookupRoutePin,
  resolveDecisionRoute,
  toDecisionRoutePin,
} from '../src/route.ts'
import type { DecisionAliasRoute, DecisionRouteDeps } from '../src/route.ts'

const LANE = 'gauge'

/** Alias map: the lane alias plus a second alias to prove isolation. */
const ALIASES: Record<string, DecisionAliasRoute> = {
  gauge: { provider: 'pi', model: 'llmbox_systemone/bjev', protocol: 'systemone' },
  sibling: { provider: 'pi', model: 'llmbox_systemone/bjev', protocol: 'systemone' },
}

function makeDeps(over: Partial<DecisionRouteDeps> = {}): DecisionRouteDeps {
  return {
    resolveAlias: (alias) => ALIASES[alias],
    connection: () => ({ baseURL: 'https://gateway.example/v1', apiKey: 'secret' }),
    ...over,
  }
}

describe('registry-derived defaults (no pin row)', () => {
  it('a concrete systemone alias with no pin row is usable on registry defaults', () => {
    const route = resolveDecisionRoute(LANE, {}, makeDeps())
    expect(route).toBeDefined()
    expect(route).toEqual({
      provider: 'pi',
      model: 'llmbox_systemone/bjev',
      baseURL: 'https://gateway.example/v1',
      apiKey: 'secret',
      // `llmbox_systemone/bjev` keys the registry as `bjev` (16384 tokens).
      revision: 'llmbox_systemone/bjev',
      perRequestTokens: 16384,
      perQuestionTokens: 16384,
      maxOutputTokens: DEFAULT_DECISION_MAX_OUTPUT_TOKENS,
      maxQuestions: DEFAULT_DECISION_MAX_QUESTIONS,
    })
    // Pinning is off unless a row asks for it.
    expect(route?.actualModelId).toBeUndefined()
  })

  it('an unknown model id falls back to the checkpoint window', () => {
    const route = resolveDecisionRoute(LANE, undefined, makeDeps({
      resolveAlias: () => ({ provider: 'pi', model: 'llmbox_systemone/unmeasured', protocol: 'systemone' }),
    }))
    expect(route?.perRequestTokens).toBe(DEFAULT_GAUGE_CONTEXT_WINDOW)
    expect(route?.perQuestionTokens).toBe(DEFAULT_GAUGE_CONTEXT_WINDOW)
  })

  it('a policy-version-only pin row keeps every other default', () => {
    const route = resolveDecisionRoute(LANE, { gauge: { revision: 'rev-7' } }, makeDeps())
    expect(route?.revision).toBe('rev-7')
    expect(route?.perRequestTokens).toBe(16384)
    expect(route?.maxOutputTokens).toBe(DEFAULT_DECISION_MAX_OUTPUT_TOKENS)
  })
})

describe('alias predicate (no capability table, no fallback)', () => {
  it('rejects a non-systemone protocol, a missing route and an incomplete route', () => {
    const cases: Array<DecisionAliasRoute | undefined> = [
      { provider: 'pi', model: 'x', protocol: 'chat' },
      { provider: 'pi', model: 'x' },
      undefined,
      { model: 'x', protocol: 'systemone' },
      { provider: 'pi', model: '', protocol: 'systemone' },
    ]
    for (const resolved of cases) {
      expect(resolveDecisionRoute(LANE, {}, makeDeps({ resolveAlias: () => resolved }))).toBeUndefined()
    }
    expect(resolveDecisionRoute('', {}, makeDeps())).toBeUndefined()
  })

  it('requires trusted connection facts', () => {
    expect(resolveDecisionRoute(LANE, {}, makeDeps({ connection: () => undefined }))).toBeUndefined()
    expect(resolveDecisionRoute(LANE, {}, makeDeps({ connection: () => ({ baseURL: '' }) }))).toBeUndefined()
  })

  it('never consults a peer alias', () => {
    const deps = makeDeps({
      resolveAlias: (alias) => (alias === 'sibling' ? ALIASES.sibling : undefined),
    })
    expect(resolveDecisionRoute(LANE, { sibling: { revision: 'rev-1' } }, deps)).toBeUndefined()
  })
})

describe('per-alias pin validation', () => {
  it('an invalid present field disables that alias and leaves the sibling usable', () => {
    const routes = {
      gauge: { 'per-request-tokens': 0 },
      sibling: { 'per-request-tokens': 2048 },
    }
    const deps = makeDeps()
    expect(resolveDecisionRoute(LANE, routes, deps)).toBeUndefined()
    const sibling = resolveDecisionRoute('sibling', routes, deps)
    expect(sibling?.perRequestTokens).toBe(2048)
  })

  it('rejects every invalid present field shape', () => {
    const invalidRows: Record<string, unknown>[] = [
      { revision: '' },
      { revision: null },
      { revision: 0 },
      { 'actual-model-id': '' },
      { 'actual-model-id': null },
      { 'actual-model-id': 'x'.repeat(257) },
      { 'per-request-tokens': null },
      { 'per-request-tokens': '' },
      { 'per-request-tokens': -1 },
      { 'per-request-tokens': 1.5 },
      { 'per-question-tokens': 0 },
      { 'max-output-tokens': 0 },
      { 'max-questions': null },
      'not-a-row',
      null,
    ]
    for (const row of invalidRows) {
      expect(resolveDecisionRoute(LANE, { gauge: row }, makeDeps())).toBeUndefined()
    }
  })

  it('an absent key is a default, not an invalid value', () => {
    const route = resolveDecisionRoute(LANE, { gauge: { 'max-questions': 8 } }, makeDeps())
    expect(route?.maxQuestions).toBe(8)
    expect(route?.perRequestTokens).toBe(16384)
    expect(route?.revision).toBe('llmbox_systemone/bjev')
  })

  it('a pin row flows actual-model-id through, absent pin leaves it undefined', () => {
    const pinned = resolveDecisionRoute(LANE, { gauge: { 'actual-model-id': 's1-ckpt-2026-01' } }, makeDeps())
    expect(pinned?.actualModelId).toBe('s1-ckpt-2026-01')
    const unpinned = resolveDecisionRoute(LANE, {}, makeDeps())
    expect(unpinned?.actualModelId).toBeUndefined()
    expect('actualModelId' in (unpinned as object)).toBe(false)
  })

  it('toDecisionRoutePin applies defaults keyed by the normalized wire model', () => {
    expect(toDecisionRoutePin({}, 'llmbox_systemone/laya')).toEqual({
      revision: 'llmbox_systemone/laya',
      perRequestTokens: 1024,
      perQuestionTokens: 1024,
      maxOutputTokens: DEFAULT_DECISION_MAX_OUTPUT_TOKENS,
      maxQuestions: DEFAULT_DECISION_MAX_QUESTIONS,
    })
  })
})

describe('folded route keys', () => {
  it('matches keys case-insensitively (routes.Gauge pins gauge)', () => {
    const lookup = lookupRoutePin('gauge', { Gauge: { revision: 'rev-2' } })
    expect(lookup).toEqual({ status: 'present', row: { revision: 'rev-2' } })
    expect(resolveDecisionRoute(LANE, { Gauge: { revision: 'rev-2' } }, makeDeps())?.revision).toBe('rev-2')
  })

  it('an absent row is reported as absent', () => {
    expect(lookupRoutePin('gauge', { other: {} })).toEqual({ status: 'absent' })
    expect(lookupRoutePin('gauge', undefined)).toEqual({ status: 'absent' })
  })

  it('a fold collision is last-wins and warns once', () => {
    const warnSpy = vi.fn()
    const warn = createWarnOnce(warnSpy)
    const routes = { gauge: { revision: 'rev-first' }, Gauge: { revision: 'rev-last' } }
    const deps = makeDeps({ warn })
    expect(resolveDecisionRoute(LANE, routes, deps)?.revision).toBe('rev-last')
    // Repeating the same resolution must not repeat the warning.
    expect(resolveDecisionRoute(LANE, routes, deps)?.revision).toBe('rev-last')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('gauge')
  })
})

describe('fault tolerance', () => {
  it('a throwing alias seam resolves to undefined, never a guess', () => {
    const deps = makeDeps({
      resolveAlias: () => {
        throw new Error('boom')
      },
    })
    expect(resolveDecisionRoute(LANE, {}, deps)).toBeUndefined()
  })

  it('createWarnOnce forwards distinct messages only', () => {
    const warnSpy = vi.fn()
    const warn = createWarnOnce(warnSpy)
    warn('a')
    warn('a')
    warn('b')
    expect(warnSpy.mock.calls.map((call) => call[0])).toEqual(['a', 'b'])
  })
})
