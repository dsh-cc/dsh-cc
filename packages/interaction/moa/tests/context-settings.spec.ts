import { describe, expect, it } from 'vitest'
import {
  CONTEXT_ROUTING_SCHEMA,
  DEFAULT_CONTEXT_ROUTING_SETTINGS,
  resolveContextRoutingSection,
} from '../src/context-settings.ts'
import { DEFAULT_MOA_SETTINGS } from '../src/settings.ts'

describe('context-routing defaults (§"Settings and modules")', () => {
  it('ships off with the policy-default thresholds', () => {
    expect(DEFAULT_CONTEXT_ROUTING_SETTINGS).toEqual({
      mode: 'off',
      timeoutMs: 1500,
      maxInputTokens: 4000,
      maxUnderTierProbability: 0.1,
      minTopProbability: 0.6,
    })
  })

  it('is carried by the moa settings defaults', () => {
    expect(DEFAULT_MOA_SETTINGS.contextRouting).toEqual(DEFAULT_CONTEXT_ROUTING_SETTINGS)
  })

  it('the nested schema materializes the defaults for an absent section', () => {
    expect(resolveContextRoutingSection(CONTEXT_ROUTING_SCHEMA(undefined))).toEqual(DEFAULT_CONTEXT_ROUTING_SETTINGS)
    expect(resolveContextRoutingSection(CONTEXT_ROUTING_SCHEMA({}))).toEqual(DEFAULT_CONTEXT_ROUTING_SETTINGS)
  })

  it('the nested schema keeps supplied fields and defaults the rest', () => {
    expect(resolveContextRoutingSection(CONTEXT_ROUTING_SCHEMA({ mode: 'active', 'timeout-ms': 3000 }))).toEqual({
      ...DEFAULT_CONTEXT_ROUTING_SETTINGS,
      mode: 'active',
      timeoutMs: 3000,
    })
  })
})

describe('resolveContextRoutingSection degradation', () => {
  it('absent or non-object input resolves to the defaults', () => {
    for (const raw of [undefined, null, 42, 'active', [], true]) {
      expect(resolveContextRoutingSection(raw)).toEqual(DEFAULT_CONTEXT_ROUTING_SETTINGS)
    }
  })

  it('a partial section keeps its own fields', () => {
    expect(
      resolveContextRoutingSection({
        mode: 'shadow',
        'timeout-ms': 2000,
        'max-input-tokens': 8000,
        'max-under-tier-probability': 0.25,
        'min-top-probability': 0.8,
      }),
    ).toEqual({
      mode: 'shadow',
      timeoutMs: 2000,
      maxInputTokens: 8000,
      maxUnderTierProbability: 0.25,
      minTopProbability: 0.8,
    })
  })

  it('an unknown mode degrades to off without touching its siblings', () => {
    expect(resolveContextRoutingSection({ mode: 'turbo', 'timeout-ms': 2000 })).toEqual({
      ...DEFAULT_CONTEXT_ROUTING_SETTINGS,
      timeoutMs: 2000,
    })
  })

  it('integer windows clamp and truncate', () => {
    expect(resolveContextRoutingSection({ 'timeout-ms': 50 }).timeoutMs).toBe(100)
    expect(resolveContextRoutingSection({ 'timeout-ms': 9000 }).timeoutMs).toBe(8000)
    expect(resolveContextRoutingSection({ 'timeout-ms': 1500.9 }).timeoutMs).toBe(1500)
    expect(resolveContextRoutingSection({ 'max-input-tokens': 100 }).maxInputTokens).toBe(512)
    expect(resolveContextRoutingSection({ 'max-input-tokens': 99_999 }).maxInputTokens).toBe(16_000)
  })

  it('probability windows clamp', () => {
    expect(resolveContextRoutingSection({ 'max-under-tier-probability': -1 }).maxUnderTierProbability).toBe(0)
    expect(resolveContextRoutingSection({ 'max-under-tier-probability': 0.9 }).maxUnderTierProbability).toBe(0.5)
    expect(resolveContextRoutingSection({ 'min-top-probability': 0.1 }).minTopProbability).toBe(0.25)
    expect(resolveContextRoutingSection({ 'min-top-probability': 2 }).minTopProbability).toBe(1)
  })

  it('non-finite and non-numeric members fall back per field', () => {
    const resolved = resolveContextRoutingSection({
      'timeout-ms': Number.NaN,
      'max-input-tokens': '4000',
      'max-under-tier-probability': Number.POSITIVE_INFINITY,
      'min-top-probability': null,
    })
    expect(resolved).toEqual(DEFAULT_CONTEXT_ROUTING_SETTINGS)
  })
})
