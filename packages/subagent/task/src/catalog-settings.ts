/**
 * Settings namespace `cc-subagent-catalog` (design
 * docs/plans/2026-11-12-selective-system-prompt-sections.md §B).
 *
 * The catalog's byte budget is measured in **UTF-8 bytes** — a char-sliced
 * `whenToUse` over a byte budget overflows on CJK content — so the per-entry
 * floor knob is `min-entry-bytes`, not chars.
 *
 * Schema-first (`registerNamespaceSafe` + the absence-preserving
 * `z.const(undefined)` union) so a genuinely absent namespace stays absent
 * instead of materializing defaults into the cascade. External keys are
 * kebab-case, the internal {@link CatalogSettings} shape is camelCase.
 *
 * `truncate: false` means "render the catalog uncapped"; it never removes the
 * section. Out-of-range values are rejected by the schema, never clamped.
 *
 * @module @dsh-cc/subagent-task/catalog-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings'
import { registerNamespaceSafe } from '@dsh-cc/settings/ns'
import z from '@deepseek-ai/schemastery'

/** The settings namespace carrying the subagent catalog's byte budget. */
export const CATALOG_SETTINGS_NAMESPACE = 'cc-subagent-catalog'

/** Internal camelCase settings shape consumed by the catalog render. */
export interface CatalogSettings {
  /** Explicit on/off for the catalog cap; `false` renders it uncapped. */
  truncate: boolean
  /** UTF-8 byte budget for the whole rendered catalog section. */
  maxBytes: number
  /** Per-entry floor for a `whenToUse` slice, in UTF-8 bytes. */
  minEntryBytes: number
}

/** One resolved settings section (raw kebab-case keys, schema-resolved). */
export interface CatalogSettingsSection {
  truncate: boolean
  'max-bytes': number
  'min-entry-bytes': number
}

/** Design-table defaults (provisional until ledger distribution data lands). */
export const DEFAULT_CATALOG_SETTINGS: CatalogSettings = {
  truncate: true,
  maxBytes: 8192,
  minEntryBytes: 40,
}

/** Design-table defaults in the kebab-case external shape. */
export const DEFAULT_CATALOG_SETTINGS_SECTION: CatalogSettingsSection = {
  truncate: DEFAULT_CATALOG_SETTINGS.truncate,
  'max-bytes': DEFAULT_CATALOG_SETTINGS.maxBytes,
  'min-entry-bytes': DEFAULT_CATALOG_SETTINGS.minEntryBytes,
}

/** Lower budget bound: below this the mandatory skeleton is unrepresentable. */
export const MIN_CATALOG_MAX_BYTES = 1024

/** Upper budget bound (a runaway budget is just the old uncapped behavior). */
export const MAX_CATALOG_MAX_BYTES = 65536

/** Lower per-entry floor: below this a `whenToUse` slice carries no signal. */
export const MIN_CATALOG_ENTRY_BYTES = 20

/** Upper per-entry floor: above this the floor would defeat the budget. */
export const MAX_CATALOG_ENTRY_BYTES = 400

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/**
 * Inner object shape (kebab keys). Absence of a field resolves to its design
 * default; `.step(1)` is schemastery's integer check (it also rejects `NaN`),
 * never a rounding pass.
 */
const SettingsObject = z.object({
  truncate: z.boolean().default(DEFAULT_CATALOG_SETTINGS.truncate),
  'max-bytes': z.number().step(1).min(MIN_CATALOG_MAX_BYTES).max(MAX_CATALOG_MAX_BYTES)
    .default(DEFAULT_CATALOG_SETTINGS.maxBytes),
  'min-entry-bytes': z.number().step(1).min(MIN_CATALOG_ENTRY_BYTES).max(MAX_CATALOG_ENTRY_BYTES)
    .default(DEFAULT_CATALOG_SETTINGS.minEntryBytes),
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
export function catalogSettings(section: CatalogSettingsSection | undefined): CatalogSettings {
  return {
    truncate: section?.truncate ?? DEFAULT_CATALOG_SETTINGS.truncate,
    maxBytes: section?.['max-bytes'] ?? DEFAULT_CATALOG_SETTINGS.maxBytes,
    minEntryBytes: section?.['min-entry-bytes'] ?? DEFAULT_CATALOG_SETTINGS.minEntryBytes,
  }
}

/**
 * Normalize a caller-supplied override (direct `renderCatalog` callers) onto
 * the defaults, so a partial settings object renders like a resolved one.
 * @param settings - the override, or `undefined` for the defaults.
 * @returns the complete internal settings.
 */
export function resolveCatalogSettings(
  settings: Partial<CatalogSettings> | undefined,
): CatalogSettings {
  return {
    truncate: settings?.truncate ?? DEFAULT_CATALOG_SETTINGS.truncate,
    maxBytes: settings?.maxBytes ?? DEFAULT_CATALOG_SETTINGS.maxBytes,
    minEntryBytes: settings?.minEntryBytes ?? DEFAULT_CATALOG_SETTINGS.minEntryBytes,
  }
}

/**
 * Register the namespace and return the live camelCase reader.
 *
 * The reader is a read-through over the provider scope, so a settings write is
 * observed by the very next render. Production has ONE render call site
 * (`AgentCatalogSection.render`, shared by the section callback, the one-shot
 * readiness reconciliation, and every `system-prompt/change` re-render), so
 * threading the reader through that one path covers all three.
 *
 * - No settings service: defaults (the helper defers the registration and this
 *   reader keeps serving the defaults until it lands).
 * - A rejected first registration: defaults — never a half-applied snapshot.
 * - An absent/broken settings layer never breaks mounting.
 * @param ctx - the owning plugin context.
 * @returns a reader resolving the current catalog settings.
 */
export function registerCatalogSettings(ctx: Context): () => CatalogSettings {
  try {
    const read = registerNamespaceSafe<CatalogSettingsSection>(
      ctx,
      CATALOG_SETTINGS_NAMESPACE as SettingsNamespace,
      SettingsSchema as unknown as z<CatalogSettingsSection>,
    )
    return () => catalogSettings(read())
  } catch {
    return () => catalogSettings(undefined)
  }
}
