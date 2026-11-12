/**
 * Settings namespace `cc-memory-section` (design
 * docs/plans/2026-11-12-selective-system-prompt-sections.md §A): the budget for
 * the COMBINED memory topic index — the one surface of the `memory` section
 * that no other cap reaches. Header, per-layer `MEMORY.md` fragments (already
 * capped by `truncateEntrypointContent`) and the "Searching past context"
 * guidance block are never touched by this namespace.
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
 * carrying `max-bytes` below {@link MIN_INDEX_MAX_BYTES} is refused whole and
 * the previous valid snapshot stays in force. The floor exists because the index
 * block always keeps its retrieval guidance; a budget under the lower bound
 * would make the cap fight the floor on every render.
 *
 * External keys are kebab-case, the internal {@link MemorySectionSettings} shape
 * is camelCase.
 * @module @dsh-cc/memory/section-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings'
import z from '@deepseek-ai/schemastery'
import { copyForMutation, registerNamespaceSafe } from '@dsh-cc/settings/ns'

/** The settings namespace carrying the combined memory index budget. */
export const SETTINGS_NAMESPACE = 'cc-memory-section'

/**
 * Design-table defaults. `maxBytes: 8192` is **provisional** until the assemble
 * ledger (doc 3) reports section-byte distributions; `truncate: true` is the
 * shipped default and `false` restores the pre-cap (uncapped) behavior without
 * ever removing the section.
 */
export const DEFAULT_MEMORY_SECTION_SETTINGS = {
  truncate: true,
  maxBytes: 8192,
} as const

/** Lower bound of `max-bytes`; below it the floor rule wins on every render. */
export const MIN_INDEX_MAX_BYTES = 1024

/** Upper bound of `max-bytes`. */
export const MAX_INDEX_MAX_BYTES = 65536

/** Internal camelCase settings shape consumed by the section renderer. */
export interface MemorySectionSettings {
  /** Whether the combined index block is capped at all (`false` = uncapped). */
  truncate: boolean
  /** UTF-8 byte ceiling for the whole combined index block. */
  maxBytes: number
}

/** One resolved settings section (raw kebab-case keys, schema-resolved). */
export interface MemorySectionSettingsSection {
  truncate?: boolean
  'max-bytes'?: number
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
}

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/**
 * Inner object shape (kebab keys). An absent field resolves to its default via
 * schemastery; `.step(1)` is schemastery's integer check (it also rejects
 * `NaN`), never a rounding pass.
 */
const SettingsObject = z.object({
  truncate: z.boolean().default(DEFAULT_MEMORY_SECTION_SETTINGS.truncate),
  'max-bytes': z.number().step(1).min(MIN_INDEX_MAX_BYTES).max(MAX_INDEX_MAX_BYTES)
    .default(DEFAULT_MEMORY_SECTION_SETTINGS.maxBytes),
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
 * below the design floor. Never repairs, never clamps: the provider turns a
 * throw into a rejected update that keeps the previous valid snapshot.
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
      `${SETTINGS_NAMESPACE}: max-bytes must be at least ${MIN_INDEX_MAX_BYTES} (the index keeps its search guidance, so the cap never goes below the floor)`,
    )
  }
}

/**
 * Map a resolved section onto the internal camelCase shape. An absent namespace
 * (no settings service, nothing registered, or an invalid first registration)
 * yields the design-table defaults.
 * @param section - the resolved kebab-case section, or `undefined`.
 * @returns the internal settings.
 */
export function memorySectionSettings(section: MemorySectionSettingsSection | undefined): MemorySectionSettings {
  const s = section ?? DEFAULT_SECTION
  return {
    truncate: s.truncate ?? DEFAULT_MEMORY_SECTION_SETTINGS.truncate,
    maxBytes: s['max-bytes'] ?? DEFAULT_MEMORY_SECTION_SETTINGS.maxBytes,
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
