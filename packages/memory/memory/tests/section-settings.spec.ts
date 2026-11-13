/**
 * Settings specs for the `cc-memory-section` namespace (design
 * docs/plans/2026-11-13-memory-section-unified-catalog.md §G): kebab-case
 * external keys, camelCase internal shape, the design-table defaults, the
 * discontinuous `description-max-bytes` domain (`0`, or 8 … 1024 — rejected,
 * never clamped), reject-invalid-keep-previous on updates, and the
 * `max-bytes >= 1024` floor that keeps the catalog cap from fighting the
 * catalog floor.
 *
 * The provider double mirrors `SettingsProvider`'s resolution contract
 * (`resolveValue`: schema first, then the owner's own `validate`, committing
 * only when neither throws) using only the public register/get seams that
 * `registerNamespaceSafe` consults.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MEMORY_SECTION_SETTINGS,
  MAX_DESCRIPTION_MAX_BYTES,
  MAX_INDEX_MAX_BYTES,
  MIN_DESCRIPTION_MAX_BYTES,
  MIN_INDEX_MAX_BYTES,
  SETTINGS_NAMESPACE,
  SettingsSchema,
  memorySectionSettings,
  registerMemorySectionSettings,
  validateMemorySectionSettings,
} from '../src/section-settings.ts'
import type { MemorySectionSettingsSection } from '../src/section-settings.ts'

type Schema = (input: unknown) => unknown

interface Registration {
  ns: string
  schema: Schema
  validate?: (value: unknown) => void
}

/** Minimal provider double: resolve-then-commit, keep-previous on a throw. */
function fakeProvider() {
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
      register(ns: string, schema: Schema, options?: { validate?: (value: unknown) => void }) {
        if (registration !== undefined) throw new Error(`settings namespace "${ns}" is already registered`)
        const candidate: Registration = {
          ns,
          schema,
          ...(options?.validate === undefined ? {} : { validate: options.validate }),
        }
        registration = candidate
        try {
          resolved = resolve({})
        } catch (error) {
          registration = undefined
          throw error
        }
        return { get: () => resolved }
      },
      get(ns: string) {
        return registration?.ns === ns ? resolved : undefined
      },
    },
    update(section: Record<string, unknown>) {
      resolved = resolve(section)
    },
  }
}

/** Minimal ctx double: only `ctx.get('settings')` is consulted. */
function fakeCtx(provider: unknown): { get: (name: string) => unknown } {
  return { get: (name: string) => (name === 'settings' ? provider : undefined) }
}

function harness() {
  const { provider, update } = fakeProvider()
  const read = registerMemorySectionSettings(fakeCtx(provider) as never)
  return { read, update }
}

describe('cc-memory-section defaults', () => {
  it('names the namespace exactly `cc-memory-section`', () => {
    expect(SETTINGS_NAMESPACE).toBe('cc-memory-section')
  })

  it('publishes the design-table defaults (truncate on, 24576 catalog bytes, 160-byte descriptions)', () => {
    expect(DEFAULT_MEMORY_SECTION_SETTINGS).toEqual({ truncate: true, maxBytes: 24576, descriptionMaxBytes: 160 })
    expect(MIN_INDEX_MAX_BYTES).toBe(1024)
    expect(MAX_INDEX_MAX_BYTES).toBe(65536)
    expect(MIN_DESCRIPTION_MAX_BYTES).toBe(8)
    expect(MAX_DESCRIPTION_MAX_BYTES).toBe(1024)
  })

  it('resolves defaults for an absent namespace', () => {
    expect(memorySectionSettings(undefined)).toEqual(DEFAULT_MEMORY_SECTION_SETTINGS)
  })

  it('resolves `undefined` without a settings service so callers keep the defaults', () => {
    const read = registerMemorySectionSettings(fakeCtx(undefined) as never)
    expect(read()).toBeUndefined()
  })

  it('maps the kebab-case section onto the three-field camelCase internal shape', () => {
    expect(memorySectionSettings({ truncate: false, 'max-bytes': 2048, 'description-max-bytes': 64 })).toEqual({
      truncate: false,
      maxBytes: 2048,
      descriptionMaxBytes: 64,
    })
  })

  it('keeps an explicit `truncate: false` through the schema (never re-defaults to true)', () => {
    const resolved = (SettingsSchema as Schema)({ truncate: false }) as MemorySectionSettingsSection
    expect(memorySectionSettings(resolved)).toEqual({ truncate: false, maxBytes: 24576, descriptionMaxBytes: 160 })
  })

  it('fills the defaults through the schema when only some fields are set', () => {
    const resolved = (SettingsSchema as Schema)({ 'max-bytes': 4096 }) as MemorySectionSettingsSection
    expect(memorySectionSettings(resolved)).toEqual({ truncate: true, maxBytes: 4096, descriptionMaxBytes: 160 })
  })

  it('preserves a stored `0` (trimming off) instead of re-defaulting it to 160', () => {
    // The schema carries no `.min()`, so the legal `0` reaches the mapping and
    // `??` keeps it (a `||` would silently restore the default).
    const resolved = (SettingsSchema as Schema)({ 'description-max-bytes': 0 }) as MemorySectionSettingsSection
    expect(resolved['description-max-bytes']).toBe(0)
    expect(memorySectionSettings(resolved)).toEqual({ truncate: true, maxBytes: 24576, descriptionMaxBytes: 0 })
    expect(memorySectionSettings({ 'description-max-bytes': 0 }).descriptionMaxBytes).toBe(0)
  })
})

describe('cc-memory-section validation', () => {
  it('accepts the design-table boundary values', () => {
    expect(() => validateMemorySectionSettings({ truncate: true, 'max-bytes': MIN_INDEX_MAX_BYTES })).not.toThrow()
    expect(() => validateMemorySectionSettings({ truncate: false, 'max-bytes': MAX_INDEX_MAX_BYTES })).not.toThrow()
  })

  it('rejects max-bytes below the 1024 floor instead of clamping it', () => {
    expect(() => validateMemorySectionSettings({ 'max-bytes': MIN_INDEX_MAX_BYTES - 1 })).toThrow()
    expect(() => validateMemorySectionSettings({ 'max-bytes': 512 })).toThrow()
    expect(() => validateMemorySectionSettings({ 'max-bytes': 0 })).toThrow()
  })

  it('rejects out-of-range, non-integer and non-finite values', () => {
    expect(() => validateMemorySectionSettings({ 'max-bytes': MAX_INDEX_MAX_BYTES + 1 })).toThrow()
    expect(() => validateMemorySectionSettings({ 'max-bytes': 2048.5 })).toThrow()
    expect(() => validateMemorySectionSettings({ 'max-bytes': Number.NaN })).toThrow()
    expect(() => validateMemorySectionSettings({ truncate: 'yes' as never })).toThrow()
  })

  it('accepts the whole description-max-bytes domain: `0`, and 8 … 1024 inclusive', () => {
    expect(() => validateMemorySectionSettings({ 'description-max-bytes': 0 })).not.toThrow()
    expect(() => validateMemorySectionSettings({ 'description-max-bytes': MIN_DESCRIPTION_MAX_BYTES })).not.toThrow()
    expect(() => validateMemorySectionSettings({ 'description-max-bytes': 160 })).not.toThrow()
    expect(() => validateMemorySectionSettings({ 'description-max-bytes': MAX_DESCRIPTION_MAX_BYTES })).not.toThrow()
  })

  it('rejects 1 … 7 and >1024 instead of clamping them', () => {
    for (let value = 1; value < MIN_DESCRIPTION_MAX_BYTES; value += 1) {
      expect(() => validateMemorySectionSettings({ 'description-max-bytes': value }), `value ${value}`).toThrow()
    }
    expect(() => validateMemorySectionSettings({ 'description-max-bytes': -1 })).toThrow()
    expect(() => validateMemorySectionSettings({ 'description-max-bytes': MAX_DESCRIPTION_MAX_BYTES + 1 })).toThrow()
    expect(() => validateMemorySectionSettings({ 'description-max-bytes': 100_000 })).toThrow()
  })

  it('rejects non-integer and non-finite description-max-bytes', () => {
    expect(() => validateMemorySectionSettings({ 'description-max-bytes': 100.5 })).toThrow()
    expect(() => validateMemorySectionSettings({ 'description-max-bytes': Number.NaN })).toThrow()
    expect(() => validateMemorySectionSettings({ 'description-max-bytes': Number.POSITIVE_INFINITY })).toThrow()
  })
})

describe('cc-memory-section live reader', () => {
  it('re-reads the scope on every call, so a write applies to the next use', () => {
    const { read, update } = harness()
    expect(read()).toEqual(DEFAULT_MEMORY_SECTION_SETTINGS)
    update({ truncate: false, 'max-bytes': 4096, 'description-max-bytes': 32 })
    expect(read()).toEqual({ truncate: false, maxBytes: 4096, descriptionMaxBytes: 32 })
    update({ 'max-bytes': 16384 })
    expect(read()).toEqual({ truncate: true, maxBytes: 16384, descriptionMaxBytes: 160 })
  })

  it('keeps the previous valid snapshot when an update is rejected', () => {
    const { read, update } = harness()
    update({ 'max-bytes': 4096, 'description-max-bytes': 0 })
    expect(() => update({ 'max-bytes': 512 })).toThrow()
    expect(read()).toEqual({ truncate: true, maxBytes: 4096, descriptionMaxBytes: 0 })
    // A rejected description ceiling keeps the snapshot too — including a `0`.
    expect(() => update({ 'description-max-bytes': 4 })).toThrow()
    expect(read()).toEqual({ truncate: true, maxBytes: 4096, descriptionMaxBytes: 0 })
  })

  it('degrades to the defaults when the first registration is rejected', () => {
    const { provider } = fakeProvider()
    const ctx = {
      get: (name: string) => (name === 'settings'
        ? {
            ...provider,
            register: (ns: string, schema: Schema, options?: { validate?: (value: unknown) => void }) => {
              // A registration whose initial resolution throws must leave
              // nothing behind: the reader then resolves undefined.
              options?.validate?.({ 'max-bytes': 1 })
              return provider.register(ns, schema, options)
            },
          }
        : undefined),
    }
    const read = registerMemorySectionSettings(ctx as never)
    expect(read()).toBeUndefined()
  })
})
