/**
 * Settings namespace `cc-memory-section`: the budget and the description
 * ceiling for the ONE unified memory catalog rendered into the `memory` section
 * (design docs/plans/2026-11-13-memory-section-unified-catalog.md §G). The
 * catalog replaced the per-layer `MEMORY.md` fragments and the derived index, so
 * this namespace now governs the whole enumeration rather than one block of it.
 *
 * Live-reader shape (the `cc-context-compression` idiom): register the namespace
 * once at mount through `registerNamespaceSafe`, re-read the resolved scope on
 * EVERY render, and let the caller fall back to
 * {@link DEFAULT_MEMORY_SECTION_SETTINGS} when the reader resolves `undefined`
 * (no settings service, nothing registered, or a rejected first registration).
 * The `z.const(undefined)` union keeps an absent namespace absent instead of
 * materializing defaults into the cascade.
 *
 * Validation policy: out-of-range values are rejected, never clamped — a write
 * carrying an unusable number is refused whole and the previous valid snapshot
 * stays in force. `max-bytes` has a floor because the catalog always keeps its
 * retrieval guidance, so a budget under the lower bound would make the cap fight
 * the floor on every render.
 *
 * External keys are kebab-case, the internal {@link MemorySectionSettings} shape
 * is camelCase.
 * @module @dsh-cc/memory/section-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings'
import z from '@deepseek-ai/schemastery'
import { copyForMutation, registerNamespaceSafe } from '@dsh-cc/settings/ns'

/** The settings namespace carrying the memory catalog budget. */
export const SETTINGS_NAMESPACE = 'cc-memory-section'

/**
 * Design-table defaults. `maxBytes: 24576` is the measured replacement for the
 * fragments + index it supersedes; `descriptionMaxBytes: 160` is the lever that
 * makes the byte budget buy entries instead of long descriptions;
 * `truncate: true` is the shipped cap and `false` renders the catalog complete.
 */
export const DEFAULT_MEMORY_SECTION_SETTINGS = {
  truncate: true,
  maxBytes: 24576,
  descriptionMaxBytes: 160,
} as const

/** Lower bound of `max-bytes`; below it the floor rule wins on every render. */
export const MIN_INDEX_MAX_BYTES = 1024

/** Upper bound of `max-bytes`. */
export const MAX_INDEX_MAX_BYTES = 65536

/**
 * Lower bound of a NON-ZERO `description-max-bytes`. A ceiling under this would
 * render `…` and almost nothing else, so it is a policy bound rather than an
 * arithmetic one — `…` itself only needs 3 bytes.
 */
export const MIN_DESCRIPTION_MAX_BYTES = 8

/** Upper bound of `description-max-bytes`. */
export const MAX_DESCRIPTION_MAX_BYTES = 1024

/** Internal camelCase settings shape consumed by the section renderer. */
export interface MemorySectionSettings {
  /** Whether catalog entries may be dropped at all (`false` = complete catalog). */
  truncate: boolean
  /** UTF-8 byte ceiling for the whole catalog block. */
  maxBytes: number
  /** Per-entry description ceiling in UTF-8 bytes; `0` disables trimming. */
  descriptionMaxBytes: number
}

/** One resolved settings section (raw kebab-case keys, schema-resolved). */
export interface MemorySectionSettingsSection {
  truncate?: boolean
  'max-bytes'?: number
  'description-max-bytes'?: number
}

/**
 * A live settings reader bound at mount. Resolves `undefined` when no namespace
 * is visible; callers then fall back to the defaults.
 */
export type MemorySectionSettingsReader = () => MemorySectionSettings | undefined

/** Design-table defaults in the external kebab-case shape. */
const DEFAULT_SECTION: MemorySectionSettingsSection = {
  truncate: DEFAULT_MEMORY_SECTION_SETTINGS.truncate,
  'max-bytes': DEFAULT_MEMORY_SECTION_SETTINGS.maxBytes,
  'description-max-bytes': DEFAULT_MEMORY_SECTION_SETTINGS.descriptionMaxBytes,
}

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/**
 * Inner object shape (kebab keys). An absent field resolves to its default via
 * schemastery; `.step(1)` is schemastery's integer check (it also rejects
 * `NaN`), never a rounding pass.
 *
 * `description-max-bytes` carries NO `.min()`/`.max()`: this object is also
 * re-admitted by {@linkcode validateMemorySectionSettings}, so a schema-level
 * lower bound would reject the legal `0` before validation could admit it. Its
 * whole domain lives in the validator.
 */
const SettingsObject = z.object({
  truncate: z.boolean().default(DEFAULT_MEMORY_SECTION_SETTINGS.truncate),
  'max-bytes': z.number().step(1).min(MIN_INDEX_MAX_BYTES).max(MAX_INDEX_MAX_BYTES)
    .default(DEFAULT_MEMORY_SECTION_SETTINGS.maxBytes),
  'description-max-bytes': z.number().step(1)
    .default(DEFAULT_MEMORY_SECTION_SETTINGS.descriptionMaxBytes),
})

/**
 * Namespace schema, wrapped in the `z.const(undefined)` union so an absent
 * namespace resolves to `undefined` (callers keep the defaults) instead of
 * materializing a section into the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>> =
  opt(SettingsObject) as unknown as z<Record<string, unknown>>

/**
 * The namespace's own validation: re-admit the section through the schema (so
 * schema-filled defaults are the source of truth) and reject a `max-bytes`
 * below the design floor or a `description-max-bytes` outside `0 ∪ [8, 1024]`.
 * Never repairs, never clamps: the provider turns a throw into a rejected update
 * that keeps the previous valid snapshot.
 * @param value - the section to check.
 */
export function validateMemorySectionSettings(value: MemorySectionSettingsSection): void {
  // A cascade section may arrive deep-frozen and schemastery re-admission
  // mutates in place — re-admit a structure-preserving copy.
  const resolved = SettingsObject(copyForMutation(value) as never) as unknown as MemorySectionSettingsSection
  const maxBytes = resolved['max-bytes']
  if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes)) {
    throw new TypeError(`${SETTINGS_NAMESPACE}: max-bytes must be a finite number`)
  }
  if (maxBytes < MIN_INDEX_MAX_BYTES) {
    throw new TypeError(
      `${SETTINGS_NAMESPACE}: max-bytes must be at least ${MIN_INDEX_MAX_BYTES} (the catalog keeps its search guidance, so the cap never goes below the floor)`,
    )
  }
  const descriptionMaxBytes = resolved['description-max-bytes']
  if (typeof descriptionMaxBytes !== 'number' || !Number.isFinite(descriptionMaxBytes)) {
    throw new TypeError(`${SETTINGS_NAMESPACE}: description-max-bytes must be a finite number`)
  }
  const usable = descriptionMaxBytes === 0
    || (descriptionMaxBytes >= MIN_DESCRIPTION_MAX_BYTES && descriptionMaxBytes <= MAX_DESCRIPTION_MAX_BYTES)
  if (!usable) {
    throw new TypeError(
      `${SETTINGS_NAMESPACE}: description-max-bytes must be 0 (no trimming) or between ${MIN_DESCRIPTION_MAX_BYTES} and ${MAX_DESCRIPTION_MAX_BYTES}`,
    )
  }
}

/**
 * Map a resolved section onto the internal camelCase shape. An absent namespace
 * (no settings service, nothing registered, or an invalid first registration)
 * yields the design-table defaults. `??` throughout, so a stored `0` (the legal
 * "no trimming" value) is preserved rather than replaced by the default.
 * @param section - the resolved kebab-case section, or `undefined`.
 * @returns the internal settings.
 */
export function memorySectionSettings(section: MemorySectionSettingsSection | undefined): MemorySectionSettings {
  const s = section ?? DEFAULT_SECTION
  return {
    truncate: s.truncate ?? DEFAULT_MEMORY_SECTION_SETTINGS.truncate,
    maxBytes: s['max-bytes'] ?? DEFAULT_MEMORY_SECTION_SETTINGS.maxBytes,
    descriptionMaxBytes: s['description-max-bytes'] ?? DEFAULT_MEMORY_SECTION_SETTINGS.descriptionMaxBytes,
  }
}

/**
 * Register the namespace and return the live camelCase reader. Never throws at
 * mount: a host without a settings service (or with a broken one) gets a reader
 * that resolves `undefined`, and the section falls back to the defaults.
 *
 * - A rejected update keeps the provider's previous valid snapshot; this reader
 *   is a read-through, so the NEXT render observes that snapshot — which is what
 *   makes a settings write apply to the direct render, the first-assembly
 *   readiness refresh and `system-prompt/change` re-renders alike.
 * @param ctx - the owning plugin context.
 * @returns the per-use reader.
 */
export function registerMemorySectionSettings(ctx: Context): MemorySectionSettingsReader {
  try {
    const read = registerNamespaceSafe<MemorySectionSettingsSection>(
      ctx,
      SETTINGS_NAMESPACE as SettingsNamespace,
      SettingsSchema as unknown as z<MemorySectionSettingsSection>,
      { validate: validateMemorySectionSettings },
    )
    return () => {
      const value = read()
      return value === undefined ? undefined : memorySectionSettings(value)
    }
  } catch {
    return () => undefined
  }
}
