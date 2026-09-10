import { describe, expect, it } from 'vitest'
import { resolveConfig, overlaySettings, DEFAULTS } from '../src/config.ts'
import type { CrusherConfig } from '../src/types.ts'

describe('config resolution', () => {
  it('applies defaults (enabled false, dry-run)', () => {
    expect(resolveConfig()).toEqual({
      enabled: false, mode: 'dry-run', minBytes: 8192, minSavingsRatio: 0.4,
      protectedTools: DEFAULTS.protectedTools,
    })
  })

  it('rejects invalid values', () => {
    expect(() => resolveConfig({ mode: 'turbo' as never })).toThrow()
    expect(() => resolveConfig({ 'min-bytes': 0 })).toThrow()
    expect(() => resolveConfig({ 'min-savings-ratio': 1.5 })).toThrow()
    expect(() => resolveConfig({ 'min-savings-ratio': -0.1 })).toThrow()
  })

  it('overlays settings, with REPLACE semantics for protected-tools', () => {
    const base = resolveConfig({ 'protected-tools': ['edit', 'write'] })
    const scope: CrusherConfig = { enabled: true, mode: 'on', 'protected-tools': ['task'] }
    const merged = overlaySettings(base, scope)
    expect(merged.enabled).toBe(true)
    expect(merged.mode).toBe('on')
    // Replace, not union: the config defaults for the list are GONE.
    expect(merged.protectedTools).toEqual(['task'])
    // Unset keys keep the config defaults.
    expect(overlaySettings(base, { 'min-bytes': 100 }).minBytes).toBe(100)
    expect(overlaySettings(base, { 'min-bytes': 100 }).protectedTools).toEqual(['edit', 'write'])
  })

  it('falls back to config defaults without a settings scope', () => {
    const base = resolveConfig()
    expect(overlaySettings(base, undefined)).toEqual(base)
    expect(overlaySettings(base, {} as CrusherConfig)).toEqual(base)
  })
})
