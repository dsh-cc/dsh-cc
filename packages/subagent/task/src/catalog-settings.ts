/**
 * Settings for the subagent catalog byte budget (design
 * `docs/plans/2026-11-12-selective-system-prompt-sections.md` §B): the
 * `cc-subagent-catalog` namespace carrying `truncate`, `max-bytes` and
 * `min-entry-bytes`. The budget contract itself (bounds, defaults, the pure
 * renderer) lives in `./catalog-budget.ts`; this module is the settings-plane
 * plumbing around it.
 *
 * Registered once at mount through {@link registerSubagentCatalogSettings};
 * the live scope is re-read on EVERY use so a settings write applies to the
 * next assembly. There is no frozen snapshot: the catalog's `render()`, the
 * 500 ms first-assembly readiness re-render and the `system-prompt/change`
 * re-render all consult the same reader, so the three paths render the same
 * text — the catalog section is a pure function of `(defs, settings)`.
 *
 * Graceful without a settings provider: the namespace reader resolves
 * `undefined` and callers fall back to {@link DEFAULT_SUBAGENT_CATALOG_SETTINGS}.
 *
 * @module @dsh-cc/subagent-task/catalog-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings/ns'
import type { SettingsReader } from '@dsh-cc/settings/ns'
import {
  DEFAULT_SUBAGENT_CATALOG_SETTINGS,
  MAX_BYTES_MAX,
  MAX_BYTES_MIN,
  MIN_ENTRY_BYTES_MAX,
  MIN_ENTRY_BYTES_MIN,
} from './catalog-budget.ts'
import type { SubagentCatalogSettings } from './catalog-budget.ts'

export {
  DEFAULT_SUBAGENT_CATALOG_SETTINGS,
  MAX_BYTES_MAX,
  MAX_BYTES_MIN,
  MIN_ENTRY_BYTES_MAX,
  MIN_ENTRY_BYTES_MIN,
} from './catalog-budget.ts'
export type { SubagentCatalogSettings } from './catalog-budget.ts'

/** The settings namespace carrying the catalog budget knobs. */
export const SUBAGENT_CATALOG_NAMESPACE = 'cc-subagent-catalog' as SettingsNamespace

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/**
 * Inner object shape (kebab-case keys, defaults mirrored from the design
 * table). Bounds are enforced at publish time so a typo never reaches a
 * render.
 */
const SettingsObject = z.object({
  truncate: z.boolean().default(DEFAULT_SUBAGENT_CATALOG_SETTINGS.truncate),
  'max-bytes': z.number().step(1).min(MAX_BYTES_MIN).max(MAX_BYTES_MAX)
    .default(DEFAULT_SUBAGENT_CATALOG_SETTINGS.maxBytes),
  'min-entry-bytes': z.number().step(1).min(MIN_ENTRY_BYTES_MIN).max(MIN_ENTRY_BYTES_MAX)
    .default(DEFAULT_SUBAGENT_CATALOG_SETTINGS.minEntryBytes),
}) as unknown as z<Record<string, unknown>>

/**
 * Namespace schema, wrapped in the `z.const(undefined)` union (the
 * `progress-rebuild` / `cc-reasoning-fold` convention) so a genuinely absent
 * namespace stays absent instead of materializing defaults into the cascade;
 * the defaults then come from {@link DEFAULT_SUBAGENT_CATALOG_SETTINGS} on
 * read.
 */
export const SubagentCatalogSettingsSchema: z<Record<string, unknown>> =
  opt(SettingsObject) as unknown as z<Record<string, unknown>>

/** Read one integer knob, falling back outside its documented bounds. */
function readInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

/**
 * Resolve one raw `cc-subagent-catalog` section into the camelCase settings.
 *
 * An absent section resolves to the defaults; an absent key resolves to its
 * own default; a value the schema would have refused resolves to the default
 * as well (never clamped into range, never thrown into a render path).
 * @param section - the raw namespace section, or undefined when absent.
 * @returns the resolved settings.
 */
export function resolveSubagentCatalogSettings(
  section: Record<string, unknown> | undefined,
): SubagentCatalogSettings {
  if (section === undefined) return DEFAULT_SUBAGENT_CATALOG_SETTINGS
  let resolved: Record<string, unknown>
  try {
    resolved = SettingsObject(section as never) as unknown as Record<string, unknown>
  } catch {
    return DEFAULT_SUBAGENT_CATALOG_SETTINGS
  }
  return {
    truncate: typeof resolved.truncate === 'boolean'
      ? resolved.truncate
      : DEFAULT_SUBAGENT_CATALOG_SETTINGS.truncate,
    maxBytes: readInt(resolved['max-bytes'], MAX_BYTES_MIN, MAX_BYTES_MAX, DEFAULT_SUBAGENT_CATALOG_SETTINGS.maxBytes),
    minEntryBytes: readInt(
      resolved['min-entry-bytes'],
      MIN_ENTRY_BYTES_MIN,
      MIN_ENTRY_BYTES_MAX,
      DEFAULT_SUBAGENT_CATALOG_SETTINGS.minEntryBytes,
    ),
  }
}

/** A live settings reader consulted per render; never undefined. */
export type SubagentCatalogSettingsReader = () => SubagentCatalogSettings

/**
 * Register the `cc-subagent-catalog` namespace and return the per-use reader.
 *
 * Graceful without a settings provider: registration degrades to a reader
 * that returns {@link DEFAULT_SUBAGENT_CATALOG_SETTINGS}. A provider that
 * refuses registration, or a stored section the schema rejects, also reads as
 * the defaults — a settings problem must never break a system-prompt render.
 * @param ctx - the mount context; registration effects bind here.
 * @returns the live reader of the resolved catalog budget settings.
 */
export function registerSubagentCatalogSettings(ctx: Context): SubagentCatalogSettingsReader {
  let read: SettingsReader<Record<string, unknown>>
  try {
    read = registerNamespaceSafe<Record<string, unknown>>(
      ctx,
      SUBAGENT_CATALOG_NAMESPACE,
      SubagentCatalogSettingsSchema,
    )
  } catch {
    return () => DEFAULT_SUBAGENT_CATALOG_SETTINGS
  }
  return () => {
    try {
      return resolveSubagentCatalogSettings(read())
    } catch {
      return DEFAULT_SUBAGENT_CATALOG_SETTINGS
    }
  }
}
