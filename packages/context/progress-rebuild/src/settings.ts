/**
 * Settings namespace for the progress-rebuild plugin (design §3.5). Kebab
 * namespace via `registerNamespaceSafe` (advisor-watchdog precedent); the
 * returned reader is a SYNCHRONOUS live read.
 *
 * @module @dsh-cc/progress-rebuild/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings-provider'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings-ns'

/** The settings namespace carrying the progress-rebuild flags. */
export const SETTINGS_NAMESPACE = 'progress-rebuild' as SettingsNamespace

/** Resolved settings shape. */
export interface ProgressRebuildSettings {
  /** Master flag. Default ON — user-decided (design §3.5). */
  enabled: boolean
  /** Hard line cap for the injected brief. Default 120. */
  maxLines: number
  /** Whether the Verified-done section renders. Default true. */
  includeVerified: boolean
}

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/** Inner object shape (kebab keys). Absence resolves to defaults. */
const SettingsObject = z.object({
  enabled: z.boolean().default(true),
  'max-lines': z.number().min(10).max(2000).default(120),
  'include-verified': z.boolean().default(true),
})

/**
 * Namespace schema, wrapped in the z.const(undefined) union (turn-rules
 * convention) so an absent namespace stays absent in the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>>
  = opt(SettingsObject) as unknown as z<Record<string, unknown>>

/** Ship defaults (§3.5): enabled true, max-lines 120, include-verified true. */
export const DEFAULT_SETTINGS = {
  enabled: true,
  maxLines: 120,
  includeVerified: true,
} as const

/**
 * Register the settings namespace and return the live synchronous reader, or
 * `undefined` when the host has no settings provider. Fail-soft: malformed
 * live scope yields the defaults; never throws into a hot path.
 */
export function registerSettings(ctx: Context): (() => { enabled: boolean; maxLines: number; includeVerified: boolean }) | undefined {
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
      if (value === undefined) return { ...DEFAULT_SETTINGS }
      return resolveSection(value)
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }
}

/** Resolve one raw section into the settings shape with defaults. */
function resolveSection(section: Record<string, unknown>): { enabled: boolean; maxLines: number; includeVerified: boolean } {
  const resolved = SettingsObject(section as unknown as Record<string, never>) as unknown as Record<string, unknown>
  const maxLines = typeof resolved['max-lines'] === 'number' && Number.isFinite(resolved['max-lines'])
    ? Math.trunc(resolved['max-lines'])
    : DEFAULT_SETTINGS.maxLines
  return {
    enabled: resolved.enabled === true,
    maxLines,
    includeVerified: resolved['include-verified'] !== false,
  }
}
