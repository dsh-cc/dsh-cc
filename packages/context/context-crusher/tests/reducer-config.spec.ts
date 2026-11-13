import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_REDUCER_GATE,
  DEFAULTS,
  mergeGateRaw,
  overlaySettings,
  reducerGateToRaw,
  resolveConfig,
  resolveGateConfig,
} from '../src/config.ts'

describe('reducer config keys (§3.6)', () => {
  it('defaults: ship dark', () => {
    const cfg = resolveConfig()
    expect(cfg.reducerEnabled).toBe(false)
    expect(cfg.reducerMaxInputTokens).toBe(30_000)
    expect(cfg.reducerMinSavingsRatio).toBe(0.5)
    expect(cfg.reducerMaxTokens).toBe(1024)
    expect(cfg.reducerTimeoutMs).toBe(10_000)
    expect(cfg.reducerAlias).toBe('haiku')
    expect(cfg.reducerCommands.length).toBeGreaterThan(0)
  })

  it('row config overrides each reducer key', () => {
    const cfg = resolveConfig({
      'reducer-enabled': true,
      'reducer-commands': ['node'],
      'reducer-max-input-tokens': 100,
      'reducer-min-savings-ratio': 0.6,
      'reducer-max-tokens': 512,
      'reducer-timeout-ms': 5000,
      'reducer-alias': 'draft',
    })
    expect(cfg.reducerEnabled).toBe(true)
    expect(cfg.reducerMaxInputTokens).toBe(100)
    expect(cfg.reducerMinSavingsRatio).toBe(0.6)
    expect(cfg.reducerMaxTokens).toBe(512)
    expect(cfg.reducerTimeoutMs).toBe(5000)
    expect(cfg.reducerAlias).toBe('draft')
    expect(cfg.reducerCommands).toEqual([/node/])
  })

  it('rejects out-of-domain reducer values', () => {
    expect(() => resolveConfig({ 'reducer-max-input-tokens': 0 })).toThrow()
    expect(() => resolveConfig({ 'reducer-min-savings-ratio': 1.5 })).toThrow()
    expect(() => resolveConfig({ 'reducer-timeout-ms': -1 })).toThrow()
  })

  it('invalid regex in reducer-commands is dropped with a debug log, never throws', () => {
    const log = vi.fn()
    const cfg = resolveConfig({ 'reducer-commands': ['vitest', '([unclosed'] }, { log })
    expect(cfg.reducerCommands.length).toBe(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reducer-commands'))
    // Invalid patterns also survive resolveConfig without a logger.
    expect(() => resolveConfig({ 'reducer-commands': ['([unclosed'] })).not.toThrow()
  })
})

describe('REPLACE overlay on the reducer keys', () => {
  it('an explicitly set value replaces the default wholesale', () => {
    const base = resolveConfig()
    const merged = overlaySettings(base, {
      'reducer-commands': ['cargo'],
      'reducer-max-input-tokens': 5,
      'reducer-min-savings-ratio': 0.9,
      'reducer-max-tokens': 64,
      'reducer-timeout-ms': 1234,
      'reducer-alias': 'sketch',
      'reducer-enabled': true,
    })
    expect(merged.reducerCommands).toEqual([/cargo/])
    expect(merged.reducerMaxInputTokens).toBe(5)
    expect(merged.reducerMinSavingsRatio).toBe(0.9)
    expect(merged.reducerMaxTokens).toBe(64)
    expect(merged.reducerTimeoutMs).toBe(1234)
    expect(merged.reducerAlias).toBe('sketch')
    expect(merged.reducerEnabled).toBe(true)
  })

  it('an absent scope leaves every reducer default in place', () => {
    const base = resolveConfig({ 'reducer-enabled': true })
    const merged = overlaySettings(base, { enabled: true })
    expect(merged.reducerEnabled).toBe(true)
    expect(merged.reducerAlias).toBe(base.reducerAlias)
    expect(merged.reducerMaxInputTokens).toBe(base.reducerMaxInputTokens)
  })
})

describe('reducer-decision-gate nested object (S1-12 § Settings)', () => {
  it('defaults: the gate ships OFF with the design table values and a clean parse', () => {
    const gate = resolveConfig().reducerDecisionGate
    expect(gate).toEqual({
      mode: 'off',
      timeoutMs: 800,
      maxInputTokens: 4096,
      maxSourceTokens: 16_384,
      maxChunks: 8,
      maxSkipIndex: 1,
      maxCompressibility: 0.2,
      cacheEntries: 128,
      cacheTtlMs: 60_000,
      valid: true,
    })
  })

  it('a valid nested object resolves every documented row', () => {
    const gate = resolveConfig({
      'reducer-decision-gate': {
        mode: 'shadow',
        'timeout-ms': 500,
        'max-input-tokens': 2048,
        'max-source-tokens': 8192,
        'max-chunks': 4,
        'max-skip-index': 0.5,
        'max-compressibility': 0.1,
        'cache-entries': 16,
        'cache-ttl-ms': 5000,
      },
    }).reducerDecisionGate
    expect(gate).toMatchObject({
      mode: 'shadow',
      timeoutMs: 500,
      maxInputTokens: 2048,
      maxSourceTokens: 8192,
      maxChunks: 4,
      maxSkipIndex: 0.5,
      maxCompressibility: 0.1,
      cacheEntries: 16,
      cacheTtlMs: 5000,
      valid: true,
    })
  })

  it('tolerance: invalid values degrade the gate to off for that resolution, never throw', () => {
    for (const raw of [
      { mode: 'turbo' },
      { 'timeout-ms': 5000 },
      { 'timeout-ms': 99 },
      { 'max-input-tokens': 100_000 },
      { 'max-input-tokens': 3.5 },
      { 'max-source-tokens': -1 },
      { 'max-chunks': 0 },
      { 'max-chunks': 17 },
      { 'max-skip-index': 4.5 },
      { 'max-compressibility': Number.NaN },
      { 'max-compressibility': 1.01 },
      { 'cache-entries': -1 },
      { 'cache-ttl-ms': 300_001 },
    ]) {
      const gate = resolveConfig({ 'reducer-decision-gate': raw }).reducerDecisionGate
      expect(gate.valid).toBe(false)
    }
    // A non-object value degrades too, and unknown keys are ignored.
    expect(resolveConfig({ 'reducer-decision-gate': 'junk' as never }).reducerDecisionGate.valid).toBe(false)
    expect(resolveConfig({ 'reducer-decision-gate': { 'future-key': 1, mode: 'active' } as never }).reducerDecisionGate)
      .toMatchObject({ mode: 'active', valid: true })
  })

  it('a degraded gate retains the mode it wrote; effective-off is the caller\u2019s rule', () => {
    const gate = resolveConfig({ 'reducer-decision-gate': { mode: 'active', 'timeout-ms': 50 } }).reducerDecisionGate
    expect(gate.mode).toBe('active')
    expect(gate.valid).toBe(false)
    expect(gate.timeoutMs).toBe(800) // the invalid row fell back to its own default
  })

  it('hierarchical override: the nested object deep-merges PER KEY, never wholesale', () => {
    const base = resolveConfig({
      'reducer-decision-gate': { mode: 'active', 'timeout-ms': 500, 'max-chunks': 4 },
    })
    expect(base.reducerDecisionGate).toMatchObject({ mode: 'active', timeoutMs: 500, maxChunks: 4, valid: true })
    // A settings scope naming only one key inherits every other config-layer value.
    const merged = overlaySettings(base, { 'reducer-decision-gate': { 'max-skip-index': 2 } })
    expect(merged.reducerDecisionGate).toMatchObject({
      mode: 'active',
      timeoutMs: 500,
      maxChunks: 4,
      maxSkipIndex: 2,
      valid: true,
    })
    // And overlaying nothing leaves the config-layer resolution untouched.
    expect(overlaySettings(base, { enabled: true }).reducerDecisionGate).toEqual(base.reducerDecisionGate)
  })

  it('a settings-layer invalid value degrades without a throw; an invalid config layer stays degraded', () => {
    const base = resolveConfig({ 'reducer-decision-gate': { mode: 'active' } })
    const degraded = overlaySettings(base, { 'reducer-decision-gate': { 'max-chunks': 'many' as never } })
    expect(degraded.reducerDecisionGate.valid).toBe(false)
    expect(degraded.reducerDecisionGate.maxChunks).toBe(8) // base value kept for the violated row

    const brokenBase = resolveConfig({ 'reducer-decision-gate': { 'timeout-ms': 50 } })
    expect(brokenBase.reducerDecisionGate.valid).toBe(false)
    // A valid settings value does not resurrect a gate broken at the config layer.
    const stillOff = overlaySettings(brokenBase, { 'reducer-decision-gate': { 'timeout-ms': 2000 } })
    expect(stillOff.reducerDecisionGate.valid).toBe(false)
    expect(stillOff.reducerDecisionGate.timeoutMs).toBe(2000)
  })

  it('legacy compat: legacy flat keys are untouched by the gate object and keep replacement semantics', () => {
    const base = resolveConfig({ 'reducer-timeout-ms': 5000, 'reducer-decision-gate': { mode: 'shadow' } })
    const merged = overlaySettings(base, {
      'reducer-timeout-ms': 1,
      'reducer-decision-gate': { 'max-chunks': 3 },
    })
    expect(merged.reducerTimeoutMs).toBe(1) // flat key REPLACED wholesale, as before
    expect(merged.reducerDecisionGate).toMatchObject({ mode: 'shadow', maxChunks: 3, valid: true })
    // The gate key alone never toggles the reducer master flags.
    expect(merged.reducerEnabled).toBe(false)
  })
})

describe('mergeGateRaw (the registerSettings merge point)', () => {
  it('merges the raw scope over the serialized base per key', () => {
    const base = { ...DEFAULT_REDUCER_GATE, mode: 'active' as const, timeoutMs: 500 }
    expect(mergeGateRaw(base, { 'max-chunks': 2 })).toEqual({ ...reducerGateToRaw(base), 'max-chunks': 2 })
    expect(mergeGateRaw(base, undefined)).toEqual(reducerGateToRaw(base))
  })

  it('passes a non-object raw value through so the tolerant parser records the degradation', () => {
    const base = { ...DEFAULT_REDUCER_GATE }
    expect(mergeGateRaw(base, 'junk')).toBe('junk')
    expect(resolveGateConfig(mergeGateRaw(base, 'junk'), base).valid).toBe(false)
    expect(resolveGateConfig(mergeGateRaw(base, { mode: 'shadow' }), base)).toMatchObject({ mode: 'shadow', valid: true })
  })

  it('legacy defaults object is frozen and carries the gate defaults', () => {
    expect(DEFAULTS.reducerDecisionGate).toEqual(DEFAULT_REDUCER_GATE)
    expect(Object.isFrozen(DEFAULT_REDUCER_GATE)).toBe(true)
  })
})
