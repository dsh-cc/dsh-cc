/**
 * Settings for the progress-rebuild plugin (design
 * docs/plans/2026-10-09-structured-progress-and-post-compact-rebuild.md §3.5),
 * namespace-registration half only for this slice (advisor-watchdog dual-half
 * pattern, packages/interaction/advisor-watchdog/src/settings.ts — the raw
 * user-layer read lands with slice B, when a consumer needs it).
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings-provider'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings-ns'

/** The settings namespace carrying the progress-rebuild flags. */
export const SETTINGS_NAMESPACE = 'progress-rebuild' as SettingsNamespace

/** Resolved settings shape. */
export interface ProgressRebuildSettings {
  enabled: boolean
  maxLines: number
  includeVerified: boolean
}

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/** Inner object shape (kebab keys). Absence resolves to defaults via schemastery. */
const SettingsObject = z.object({
  enabled: z.boolean().default(false),
  'max-lines': z.number().min(1).default(120),
  'include-verified': z.boolean().default(true),
})

/**
 * Namespace schema. Wrapped in the z.const(undefined) union (turn-rules
 * convention) so a genuinely absent namespace value stays absent instead of
 * materializing defaults into the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>> =
  opt(SettingsObject) as unknown as z<Record<string, unknown>>

/** Ship-dark defaults (§3.1/§3.5): enabled false. */
export const DEFAULT_PROGRESS_REBUILD_SETTINGS: ProgressRebuildSettings = {
  enabled: false,
  maxLines: 120,
  includeVerified: true,
}

/**
 * Register the settings namespace (for /config UX and validation only).
 * Returns the live reader, or `undefined` when the host has no settings
 * provider.
 */
export function registerSettings(ctx: Context): (() => ProgressRebuildSettings) | undefined {
  const settings = ctx.get('settings') as object | undefined
  if (settings === undefined) return undefined
  const read = registerNamespaceSafe<Record<string, unknown>>(
    ctx,
    SETTINGS_NAMESPACE,
    SettingsSchema as unknown as z<Record<string, unknown>>,
  )
  return () => {
    try {
      const value = read()
      if (value === undefined) return DEFAULT_PROGRESS_REBUILD_SETTINGS
      return resolveSection(value as unknown as Record<string, unknown>)
    } catch {
      // Malformed live scope → ship defaults; never throw into a hot path.
      return DEFAULT_PROGRESS_REBUILD_SETTINGS
    }
  }
}

/** Resolve one raw section into the settings shape with defaults. */
function resolveSection(section: Record<string, unknown>): ProgressRebuildSettings {
  const resolved = SettingsObject(section as unknown as Record<string, never>) as unknown as Record<string, unknown>
  const asInt = (value: unknown, fallback: number): number => {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
    return n
  }
  return {
    enabled: resolved.enabled as boolean,
    maxLines: asInt(resolved['max-lines'], 120),
    includeVerified: (resolved['include-verified'] as boolean) ?? true,
  }
}
