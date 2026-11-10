/**
 * Settings pins for namespace `cc-systemone-memory-extraction` (design
 * docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md §"Settings,
 * defaults and ranges"): the default snapshot is off, every design-table bound
 * is enforced, and an invalid update rejects the WHOLE section while the
 * previous accepted snapshot stays effective.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXTRACTION_DECISION_SETTINGS,
  MAX_SKIP_PROBABILITY,
  SETTINGS_NAMESPACE,
  SettingsSchema,
  createExtractionSettingsReader,
  parseExtractionDecisionSettings,
  registerExtractionSettings,
  type ExtractionDecisionSettings,
} from '../src/extraction-settings.ts'

/** Minimal settings-provider double: a live section read, no scope object. */
function fakeSettingsCtx(initial?: Record<string, unknown>) {
  const state: { section: Record<string, unknown> | undefined } = { section: initial }
  const provider = {
    register: () => undefined,
    get: () => state.section,
  }
  const ctx = { get: (name: string) => (name === 'settings' ? provider : undefined) } as never
  return {
    ctx,
    setSection(next: Record<string, unknown> | undefined) {
      state.section = next
    },
  }
}

/** A fully customized, in-range section (every field differs from its default). */
const CUSTOM_SECTION = {
  mode: 'active',
  'timeout-ms': 2500,
  'max-input-tokens': 8000,
  'max-surface-events': 96,
  'max-state-bytes': 65536,
  'skip-probability': 0.1,
  'audit-every-n-skips': 7,
  'failure-cooldown-ms': 60_000,
  'session-state-cap': 400,
}

const CUSTOM_SETTINGS: ExtractionDecisionSettings = {
  mode: 'active',
  timeoutMs: 2500,
  maxInputTokens: 8000,
  maxSurfaceEvents: 96,
  maxStateBytes: 65_536,
  skipProbability: 0.1,
  auditEveryNSkips: 7,
  failureCooldownMs: 60_000,
  sessionStateCap: 400,
}

describe('cc-systemone-memory-extraction defaults', () => {
  it('ships the design-table defaults, off', () => {
    expect(SETTINGS_NAMESPACE).toBe('cc-systemone-memory-extraction')
    expect(DEFAULT_EXTRACTION_DECISION_SETTINGS).toEqual({
      mode: 'off',
      timeoutMs: 1500,
      maxInputTokens: 6000,
      maxSurfaceEvents: 64,
      maxStateBytes: 32_768,
      skipProbability: 0.05,
      auditEveryNSkips: 20,
      failureCooldownMs: 30_000,
      sessionStateCap: 200,
    })
  })

  it('reads the off defaults when the namespace is unregistered (no runner is read)', () => {
    const { ctx } = fakeSettingsCtx(undefined)
    expect(registerExtractionSettings(ctx)()).toEqual(DEFAULT_EXTRACTION_DECISION_SETTINGS)
  })

  it('reads the off defaults when the host has no settings provider at all', () => {
    const ctx = { get: () => undefined } as never
    expect(registerExtractionSettings(ctx)()).toEqual(DEFAULT_EXTRACTION_DECISION_SETTINGS)
  })

  it('reads the off defaults when registration itself fails', () => {
    const ctx = {
      get: () => ({
        register: () => {
          throw new Error('boom')
        },
        get: () => undefined,
      }),
    } as never
    expect(registerExtractionSettings(ctx)()).toEqual(DEFAULT_EXTRACTION_DECISION_SETTINGS)
  })

  it('keeps absence absent in the schema and materializes defaults for an empty section', () => {
    expect(SettingsSchema(undefined as unknown as Record<string, never>)).toBeUndefined()
    const resolved = SettingsSchema({} as unknown as Record<string, never>) as Record<string, unknown>
    expect(resolved).toMatchObject({ mode: 'off', 'skip-probability': 0.05, 'max-surface-events': 64 })
  })
})

describe('parseExtractionDecisionSettings', () => {
  it('resolves kebab-case keys into the internal camelCase snapshot', () => {
    expect(parseExtractionDecisionSettings(CUSTOM_SECTION)).toEqual(CUSTOM_SETTINGS)
  })

  it('treats an absent section as unparseable (defaults belong to the reader)', () => {
    expect(parseExtractionDecisionSettings(undefined)).toBeUndefined()
  })

  it('accepts the inclusive probability bounds and rejects one step past them', () => {
    expect(parseExtractionDecisionSettings({ 'skip-probability': 0 })?.skipProbability).toBe(0)
    expect(parseExtractionDecisionSettings({ 'skip-probability': MAX_SKIP_PROBABILITY })?.skipProbability).toBe(0.2)
    expect(parseExtractionDecisionSettings({ 'skip-probability': 0.2000001 })).toBeUndefined()
    expect(parseExtractionDecisionSettings({ 'skip-probability': -0.01 })).toBeUndefined()
  })

  it('rejects NaN and non-numeric probabilities', () => {
    expect(parseExtractionDecisionSettings({ 'skip-probability': Number.NaN })).toBeUndefined()
    expect(parseExtractionDecisionSettings({ 'skip-probability': '0.05' })).toBeUndefined()
  })

  it('rejects a negative or non-integer timeout', () => {
    expect(parseExtractionDecisionSettings({ 'timeout-ms': -1 })).toBeUndefined()
    expect(parseExtractionDecisionSettings({ 'timeout-ms': 1499.5 })).toBeUndefined()
    expect(parseExtractionDecisionSettings({ 'timeout-ms': 99 })).toBeUndefined()
    expect(parseExtractionDecisionSettings({ 'timeout-ms': 5001 })).toBeUndefined()
  })

  it('rejects an unknown mode', () => {
    expect(parseExtractionDecisionSettings({ mode: 'always' })).toBeUndefined()
  })

  it('ignores the retired route-alias key: the lane alias is a constant', () => {
    // The consumer-facing key is gone. A stale key neither rejects the section
    // nor survives into the effective settings; the gate pins
    // `DECISION_LANE_ALIAS` on every request.
    const parsed = parseExtractionDecisionSettings({ mode: 'active', 'route-alias': 'gauge-shadow' })
    expect(parsed?.mode).toBe('active')
    expect(Object.keys(parsed!)).not.toContain('routeAlias')
  })

  it('enforces every integer knob in its design-table range', () => {
    for (const key of [
      'max-input-tokens',
      'max-surface-events',
      'max-state-bytes',
      'audit-every-n-skips',
      'failure-cooldown-ms',
      'session-state-cap',
    ]) {
      expect(parseExtractionDecisionSettings({ [key]: 0 }), key).toBeUndefined()
      expect(parseExtractionDecisionSettings({ [key]: 0.5 }), key).toBeUndefined()
    }
  })
})

describe('createExtractionSettingsReader (dynamic snapshot)', () => {
  it('re-reads the live section on every call', () => {
    const { ctx, setSection } = fakeSettingsCtx({})
    const read = registerExtractionSettings(ctx)
    expect(read().mode).toBe('off')
    setSection(CUSTOM_SECTION)
    expect(read()).toEqual(CUSTOM_SETTINGS)
  })

  it('rejects an invalid probability update and keeps the previous snapshot', () => {
    const { ctx, setSection } = fakeSettingsCtx(CUSTOM_SECTION)
    const read = registerExtractionSettings(ctx)
    expect(read().mode).toBe('active')
    setSection({ ...CUSTOM_SECTION, 'skip-probability': 0.5 })
    expect(read()).toEqual(CUSTOM_SETTINGS)
  })

  it('rejects a negative timeout and keeps the previous snapshot', () => {
    const { ctx, setSection } = fakeSettingsCtx(CUSTOM_SECTION)
    const read = registerExtractionSettings(ctx)
    expect(read()).toEqual(CUSTOM_SETTINGS)
    setSection({ ...CUSTOM_SECTION, 'timeout-ms': -5 })
    expect(read()).toEqual(CUSTOM_SETTINGS)
  })

  it('rejects an unknown mode and keeps the previous snapshot', () => {
    const { ctx, setSection } = fakeSettingsCtx(CUSTOM_SECTION)
    const read = registerExtractionSettings(ctx)
    expect(read()).toEqual(CUSTOM_SETTINGS)
    setSection({ ...CUSTOM_SECTION, mode: 'on' })
    expect(read()).toEqual(CUSTOM_SETTINGS)
  })

  it('a partly invalid update applies nothing (whole-section rejection)', () => {
    const { ctx, setSection } = fakeSettingsCtx(CUSTOM_SECTION)
    const read = registerExtractionSettings(ctx)
    expect(read()).toEqual(CUSTOM_SETTINGS)
    // One valid knob changes alongside one invalid knob: nothing is applied.
    setSection({ ...CUSTOM_SECTION, 'timeout-ms': 3000, 'max-surface-events': 5000 })
    expect(read()).toEqual(CUSTOM_SETTINGS)
  })

  it('reads the defaults again once the namespace disappears', () => {
    const { ctx, setSection } = fakeSettingsCtx(CUSTOM_SECTION)
    const read = registerExtractionSettings(ctx)
    expect(read().mode).toBe('active')
    setSection(undefined)
    expect(read()).toEqual(DEFAULT_EXTRACTION_DECISION_SETTINGS)
  })

  it('serves the defaults when the live read throws', () => {
    const read = createExtractionSettingsReader(() => {
      throw new Error('provider died')
    })
    expect(read()).toEqual(DEFAULT_EXTRACTION_DECISION_SETTINGS)
  })
})
