/**
 * Settings namespace `cc-memory-section` (design
 * docs/plans/2026-11-12-selective-system-prompt-sections.md §A).
 *
 * Only the combined topic index block is budgeted: the section header, the
 * per-layer `MEMORY.md` fragments (already capped by
 * `truncateEntrypointContent`) and the "Searching past context" guidance block
 * render unchanged. The budget is measured in **UTF-8 bytes** — the unit the
 * existing memory truncation layer already uses — never `text.length`.
 *
 * Schema-first (`registerNamespaceSafe` + the absence-preserving
 * `z.const(undefined)` union) so a genuinely absent namespace stays absent
 * instead of materializing defaults into the cascade. External keys are
 * kebab-case, the internal {@link MemorySectionSettings} shape is camelCase.
 *
 * `truncate: false` means "render the index uncapped"; it never removes the
 * section. `max-bytes` below 1024 is rejected by the schema (the budget is a
 * cap above the mandatory floor, never below it).
 *
 * @module @dsh-cc/memory/section-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings'
import { registerNamespaceSafe } from '@dsh-cc/settings/ns'
import z from '@deepseek-ai/schemastery'

/** The settings namespace carrying the memory section's index budget. */
export const SECTION_SETTINGS_NAMESPACE = 'cc-memory-section'

/** Internal camelCase settings shape consumed by the section render. */
export interface MemorySectionSettings {
  /** Explicit on/off for the combined-index cap; `false` renders it uncapped. */
  truncate: boolean
  /** UTF-8 byte budget for the combined topic index block. */
  maxBytes: number
}

/** One resolved settings section (raw kebab-case keys, schema-resolved). */
export interface MemorySectionSettingsSection {
  truncate: boolean
  'max-bytes': number
}

/** Design-table defaults (provisional until ledger distribution data lands). */
export const DEFAULT_MEMORY_SECTION_SETTINGS: MemorySectionSettings = {
  truncate: true,
  maxBytes: 8192,
}

/** Design-table defaults in the kebab-case external shape. */
export const DEFAULT_MEMORY_SECTION_SETTINGS_SECTION: MemorySectionSettingsSection = {
  truncate: DEFAULT_MEMORY_SECTION_SETTINGS.truncate,
  'max-bytes': DEFAULT_MEMORY_SECTION_SETTINGS.maxBytes,
}

/** Lower budget bound: below this the floor rule could never be honoured. */
export const MIN_SECTION_MAX_BYTES = 1024

/** Upper budget bound (a runaway budget is just the old uncapped behavior). */
export const MAX_SECTION_MAX_BYTES = 65536

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/**
 * Inner object shape (kebab keys). Absence of a field resolves to its design
 * default; `.step(1)` is schemastery's integer check (it also rejects `NaN`),
 * never a rounding pass. Out-of-range values are rejected, never clamped.
 */
const SettingsObject = z.object({
  truncate: z.boolean().default(DEFAULT_MEMORY_SECTION_SETTINGS.truncate),
  'max-bytes': z.number().step(1).min(MIN_SECTION_MAX_BYTES).max(MAX_SECTION_MAX_BYTES)
    .default(DEFAULT_MEMORY_SECTION_SETTINGS.maxBytes),
})

/**
 * Namespace schema, wrapped in the `z.const(undefined)` union so an absent
 * namespace resolves to `undefined` (callers then keep the defaults) instead of
 * materializing a section into the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>> =
  opt(SettingsObject) as unknown as z<Record<string, unknown>>

/**
 * Map a resolved section onto the internal camelCase shape. An absent
 * namespace (no settings service, nothing registered, or an invalid first
 * registration) yields the design-table defaults.
 * @param section - the resolved kebab-case section, or `undefined`.
 * @returns the internal settings.
 */
export function memorySectionSettings(
  section: MemorySectionSettingsSection | undefined,
): MemorySectionSettings {
  return {
    truncate: section?.truncate ?? DEFAULT_MEMORY_SECTION_SETTINGS.truncate,
    maxBytes: section?.['max-bytes'] ?? DEFAULT_MEMORY_SECTION_SETTINGS.maxBytes,
  }
}

/**
 * Normalize a caller-supplied override (direct render callers) onto the
 * defaults, so a partial settings object renders like a resolved one.
 * @param settings - the override, or `undefined` for the defaults.
 * @returns the complete internal settings.
 */
export function resolveMemorySectionSettings(
  settings: Partial<MemorySectionSettings> | undefined,
): MemorySectionSettings {
  return {
    truncate: settings?.truncate ?? DEFAULT_MEMORY_SECTION_SETTINGS.truncate,
    maxBytes: settings?.maxBytes ?? DEFAULT_MEMORY_SECTION_SETTINGS.maxBytes,
  }
}

/**
 * Register the namespace and return the live camelCase reader.
 *
 * The reader is a read-through over the provider scope, so a settings write is
 * observed by the very next render — the direct section callback, the one-shot
 * first-assembly readiness refresh, and every `system-prompt/change` re-render
 * all consult it (they share one render function).
 *
 * - No settings service: defaults (the helper defers the registration and this
 *   reader keeps serving the defaults until it lands).
 * - A rejected first registration: defaults — never a half-applied snapshot.
 * - An absent/broken settings layer never breaks mounting.
 * @param ctx - the owning plugin context.
 * @returns a reader resolving the current section settings.
 */
export function registerMemorySectionSettings(ctx: Context): () => MemorySectionSettings {
  try {
    const read = registerNamespaceSafe<MemorySectionSettingsSection>(
      ctx,
      SECTION_SETTINGS_NAMESPACE as SettingsNamespace,
      SettingsSchema as unknown as z<MemorySectionSettingsSection>,
    )
    return () => memorySectionSettings(read())
  } catch {
    return () => memorySectionSettings(undefined)
  }
}
