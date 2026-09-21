import { describe, expect, it, vi } from 'vitest'
import { DEFAULTS, resolveConfig, overlaySettings } from '../src/config.ts'

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
