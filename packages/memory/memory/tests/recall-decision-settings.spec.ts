/**
 * Settings specs for the `cc-systemone-memory-recall` namespace (design
 * docs/plans/2026-11-02-systemone-03-memory-recall.md §"Configuration has its
 * own namespace"): kebab-case external keys, camelCase internal shape, the
 * design-table defaults, reject-invalid-keep-previous on updates, defaults on
 * an invalid first registration, and NO clamping of out-of-range values.
 *
 * The provider double below mirrors `SettingsProvider`'s resolution contract
 * (`resolveValue`: schema first, then the owner's own `validate`, committing
 * only when neither throws) using only the public register/get seams that
 * `registerNamespaceSafe` consults.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RECALL_DECISION_SETTINGS,
  SETTINGS_NAMESPACE,
  SettingsSchema,
  recallDecisionSettings,
  registerRecallDecisionSettings,
  validateRecallDecisionSettings,
} from '../src/recall-decision-settings.ts'
import type { RecallDecisionSection } from '../src/recall-decision-settings.ts'

/** A full valid user section (kebab-case, every field explicit). */
const VALID_SECTION: RecallDecisionSection = {
  mode: 'active',
  'timeout-ms': 2000,
  'max-input-tokens': 8000,
  'max-candidates': 64,
  'batch-size': 16,
  'include-probability': 0.8,
  'exclude-probability': 0.2,
  'fallback-max-candidates': 128,
  'fallback-max-bytes': 32768,
}

type Schema = (input: unknown) => unknown

interface Registration {
  ns: string
  schema: Schema
  validate?: (value: unknown) => void
}

/**
 * Minimal provider double. `register` resolves the namespace exactly as the
 * real provider does: run the schema, then the owner's `validate`, and only
 * commit when both succeed (so a throwing first registration leaves nothing
 * registered). `update` re-runs that resolution against a candidate user
 * section, keeping the previous snapshot when it throws.
 */
function fakeProvider(): {
  provider: {
    register: (ns: string, schema: Schema, options?: { validate?: (value: unknown) => void }) => { get: () => unknown }
    get: (ns: string) => unknown
  }
  update: (section: Record<string, unknown>) => void
} {
  let registration: Registration | undefined
  let resolved: unknown
  const resolve = (section: Record<string, unknown>): unknown => {
    if (registration === undefined) throw new Error('no registration')
    const value = registration.schema(section)
    registration.validate?.(value)
    return value
  }
  return {
    provider: {
      register(ns, schema, options) {
        if (registration !== undefined) throw new Error(`settings namespace "${ns}" is already registered`)
        const candidate: Registration = { ns, schema, ...(options?.validate === undefined ? {} : { validate: options.validate }) }
        // Resolve BEFORE committing — the real provider throws out of `register`.
        registration = candidate
        try {
          resolved = resolve({})
        } catch (error) {
          registration = undefined
          throw error
        }
        return { get: () => resolved }
      },
      get(ns) {
        return registration?.ns === ns ? resolved : undefined
      },
    },
    update(section) {
      resolved = resolve(section)
    },
  }
}

/** Minimal ctx double: only `ctx.get('settings')` is consulted. */
function fakeCtx(provider: unknown): { get: (name: string) => unknown } {
  return { get: (name: string) => (name === 'settings' ? provider : undefined) }
}

/** Register the namespace against a fresh double and expose its reader. */
function harness(): { read: () => ReturnType<typeof recallDecisionSettings>; update: (section: Record<string, unknown>) => void } {
  const { provider, update } = fakeProvider()
  const read = registerRecallDecisionSettings(fakeCtx(provider) as never)
  return { read, update }
}

describe('cc-systemone-memory-recall defaults', () => {
  it('uses the design-table defaults (mode off) when no settings service is present', () => {
    const read = registerRecallDecisionSettings(fakeCtx(undefined) as never)
    expect(read()).toEqual({
      mode: 'off',
      timeoutMs: 1500,
      maxInputTokens: 6000,
      maxCandidates: 96,
      batchSize: 24,
      includeProbability: 0.75,
      excludeProbability: 0.25,
      fallbackMaxCandidates: 256,
      fallbackMaxBytes: 65536,
    })
    expect(read()).toEqual(DEFAULT_RECALL_DECISION_SETTINGS)
  })

  it('names the namespace exactly `cc-systemone-memory-recall`', () => {
    expect(SETTINGS_NAMESPACE).toBe('cc-systemone-memory-recall')
  })

  it('resolves defaults for an absent namespace', () => {
    expect(recallDecisionSettings(undefined)).toEqual(DEFAULT_RECALL_DECISION_SETTINGS)
  })

  it('maps every kebab-case external field onto the camelCase internal shape', () => {
    expect(recallDecisionSettings(VALID_SECTION)).toEqual({
      mode: 'active',
      timeoutMs: 2000,
      maxInputTokens: 8000,
      maxCandidates: 64,
      batchSize: 16,
      includeProbability: 0.8,
      excludeProbability: 0.2,
      fallbackMaxCandidates: 128,
      fallbackMaxBytes: 32768,
    })
  })

  it('ignores the retired route-alias key: the lane alias is a constant', () => {
    // `route-alias` is no longer a consumer setting. A stale key in a user
    // section does not reject the section and never reaches the internal shape:
    // every decision request names `DECISION_LANE_ALIAS` instead.
    const stale = (SettingsSchema as Schema)({ ...VALID_SECTION, 'route-alias': 'gauge-alt' }) as RecallDecisionSection
    expect(recallDecisionSettings(stale).mode).toBe('active')
    expect(Object.keys(recallDecisionSettings(stale))).not.toContain('routeAlias')
  })

  it('falls back to the defaults through the schema when only some fields are set', () => {
    const partial = (SettingsSchema as Schema)({ mode: 'shadow' }) as RecallDecisionSection
    expect(recallDecisionSettings(partial)).toMatchObject({ mode: 'shadow', timeoutMs: 1500, batchSize: 24 })
  })
})

describe('cc-systemone-memory-recall validation', () => {
  it('accepts the design-table boundary values', () => {
    const boundaries: RecallDecisionSection[] = [
      { ...VALID_SECTION, 'timeout-ms': 100, 'max-input-tokens': 512, 'max-candidates': 1, 'batch-size': 1 },
      { ...VALID_SECTION, 'timeout-ms': 5000, 'max-input-tokens': 16000, 'max-candidates': 256, 'batch-size': 32, 'fallback-max-candidates': 256 },
      { ...VALID_SECTION, 'include-probability': 1, 'exclude-probability': 0 },
      { ...VALID_SECTION, 'include-probability': 0.5, 'exclude-probability': 0.5 - 1e-9 },
      { ...VALID_SECTION, 'fallback-max-candidates': 64, 'fallback-max-bytes': 4096 },
      { ...VALID_SECTION, 'fallback-max-candidates': 1024, 'fallback-max-bytes': 262144 },
    ]
    for (const section of boundaries) {
      expect(() => validateRecallDecisionSettings(section), JSON.stringify(section)).not.toThrow()
    }
  })

  it('rejects exclude-probability at or above include-probability', () => {
    expect(() => validateRecallDecisionSettings({ ...VALID_SECTION, 'include-probability': 0.5, 'exclude-probability': 0.5 })).toThrow()
    expect(() => validateRecallDecisionSettings({ ...VALID_SECTION, 'include-probability': 0.6, 'exclude-probability': 0.7 })).toThrow()
  })

  it('rejects fallback-max-candidates below max-candidates', () => {
    expect(() => validateRecallDecisionSettings({ ...VALID_SECTION, 'max-candidates': 96, 'fallback-max-candidates': 95 })).toThrow()
    expect(() => validateRecallDecisionSettings({ ...VALID_SECTION, 'max-candidates': 96, 'fallback-max-candidates': 96 })).not.toThrow()
  })

  it('rejects out-of-range and non-integer values without clamping them', () => {
    const invalid: Partial<RecallDecisionSection>[] = [
      { mode: 'sometimes' as never },
      { 'timeout-ms': 99 },
      { 'timeout-ms': 5001 },
      { 'timeout-ms': 1500.5 },
      { 'timeout-ms': Number.NaN },
      { 'max-input-tokens': 511 },
      { 'max-input-tokens': 16001 },
      { 'max-input-tokens': 6000.5 },
      { 'max-candidates': 0 },
      { 'max-candidates': 257 },
      { 'batch-size': 0 },
      { 'batch-size': 33 },
      { 'batch-size': 2.5 },
      { 'include-probability': 0.49 },
      { 'include-probability': 1.01 },
      { 'exclude-probability': -0.01 },
      { 'exclude-probability': 0.51 },
      { 'exclude-probability': Number.POSITIVE_INFINITY },
      { 'fallback-max-candidates': 0 },
      { 'fallback-max-candidates': 1025 },
      { 'fallback-max-candidates': 12.5 },
      { 'fallback-max-bytes': 4095 },
      { 'fallback-max-bytes': 262145 },
      { 'fallback-max-bytes': 65536.5 },
    ]
    for (const patch of invalid) {
      const section = { ...VALID_SECTION, ...patch } as RecallDecisionSection
      expect(() => validateRecallDecisionSettings(section), JSON.stringify(patch)).toThrow()
      // Never clamp: the schema itself must refuse the value too.
      expect(() => (SettingsSchema as Schema)(section), JSON.stringify(patch)).toThrow()
    }
  })
})

describe('cc-systemone-memory-recall live updates', () => {
  it('rejects an invalid update and keeps the previous valid snapshot', () => {
    const { read, update } = harness()
    update(VALID_SECTION as unknown as Record<string, unknown>)
    expect(read()).toMatchObject({ mode: 'active', timeoutMs: 2000, maxCandidates: 64 })

    expect(() => update({ ...VALID_SECTION, 'exclude-probability': 0.8 })).toThrow()
    expect(read()).toMatchObject({ mode: 'active', timeoutMs: 2000, maxCandidates: 64 })

    expect(() => update({ ...VALID_SECTION, 'timeout-ms': 99999 })).toThrow()
    expect(read()).toMatchObject({ timeoutMs: 2000 })

    expect(() => update({ ...VALID_SECTION, 'max-candidates': 96, 'fallback-max-candidates': 32 })).toThrow()
    expect(read()).toMatchObject({ maxCandidates: 64, fallbackMaxCandidates: 128 })
  })

  it('never clamps an invalid probability into range on update', () => {
    const { read, update } = harness()
    update(VALID_SECTION as unknown as Record<string, unknown>)
    expect(() => update({ ...VALID_SECTION, 'include-probability': 1.4 })).toThrow()
    expect(read()).toMatchObject({ includeProbability: 0.8 })
  })

  it('uses the defaults when the first registration is invalid', () => {
    // The double's `register` resolves the seeded section BEFORE committing, so
    // an invalid seeded section throws out of `register`. The reader must then
    // degrade to the defaults rather than a half-applied snapshot.
    const ctx = {
      get: () => ({
        register: () => {
          throw new TypeError('settings: invalid cc-systemone-memory-recall section')
        },
        get: () => undefined,
      }),
      inject: () => {
        throw new TypeError('inject unavailable')
      },
    }
    expect(registerRecallDecisionSettings(ctx as never)()).toEqual(DEFAULT_RECALL_DECISION_SETTINGS)
  })
})
