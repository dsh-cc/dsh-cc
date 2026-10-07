/**
 * Unit spec for the per-model gauge context-window resolution chain (design
 * doc `docs/plans/2026-10-07-gauge-context-window-per-model.md` §4.1/§4.2):
 * settings > measured registry > provider record > default, with prefix
 * normalization and the structural mismatch surface.
 */
import { describe, expect, it } from 'vitest'
import { GAUGE_MODEL_CONTEXT_WINDOWS, normalizeGaugeModelId, resolveGaugeContextWindow } from '../src/gauge-adapter.ts'

describe('normalizeGaugeModelId', () => {
  it('strips any gateway prefix through the last slash; bare ids pass through', () => {
    expect(normalizeGaugeModelId('llmbox_systemone/bjev')).toBe('bjev')
    expect(normalizeGaugeModelId('bjev')).toBe('bjev')
    expect(normalizeGaugeModelId('foo/bar')).toBe('bar')
    expect(normalizeGaugeModelId('a/b/c')).toBe('c')
  })
})

describe('resolveGaugeContextWindow (precedence)', () => {
  it('level 1 — settings override wins over everything', () => {
    expect(resolveGaugeContextWindow('bjev', { settingsOverride: 9999, recordValue: 2048 })).toEqual({
      window: 9999, source: 'settings',
    })
  })

  it('level 2 — registry hits for known models (bare and prefixed ids)', () => {
    expect(resolveGaugeContextWindow('bjev', {})).toEqual({ window: 16384, source: 'registry' })
    expect(resolveGaugeContextWindow('llmbox_systemone/bjev', {})).toEqual({ window: 16384, source: 'registry' })
    expect(resolveGaugeContextWindow('laya', {})).toEqual({ window: 1024, source: 'registry' })
  })

  it('level 3 — provider record applies only on a registry miss', () => {
    expect(resolveGaugeContextWindow('foo/bar', { recordValue: 2048 })).toEqual({ window: 2048, source: 'record' })
    expect(resolveGaugeContextWindow('llmbox_systemone/xyz', { recordValue: 2048 })).toEqual({ window: 2048, source: 'record' })
  })

  it('level 4 — default when nothing applies', () => {
    expect(resolveGaugeContextWindow('foo/bar', {})).toEqual({ window: 1024, source: 'default' })
  })

  it('mismatch struct surfaces only when a differing record value is shadowed', () => {
    expect(resolveGaugeContextWindow('bjev', { recordValue: 1024 })).toEqual({
      window: 16384, source: 'registry', mismatch: { registry: 16384, record: 1024 },
    })
    // Agreeing values: no mismatch.
    expect(resolveGaugeContextWindow('laya', { recordValue: 1024 })).toEqual({ window: 1024, source: 'registry' })
    // No record: no mismatch.
    expect(resolveGaugeContextWindow('bjev', {})).toEqual({ window: 16384, source: 'registry' })
  })

  it('registry values match the measured table', () => {
    expect(GAUGE_MODEL_CONTEXT_WINDOWS).toEqual({ laya: 1024, bjev: 16384 })
  })
})
