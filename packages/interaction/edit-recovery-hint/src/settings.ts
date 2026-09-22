/**
 * Settings for the edit recovery hint (design doc Track B), two halves —
 * same split as post-edit-verify:
 *
 * 1. namespace registration via `@dsh-cc/settings-ns` (schema uses the kebab
 *    keys users author in settings.json), for /config UX and validation only;
 * 2. a RAW user-layer read of `<dshHome>/settings.json` that bypasses the
 *    merged cascade entirely, so project scope is structurally invisible.
 *    The file is re-read per use (a few KB), which gives free hot reload.
 *
 * @module
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings-ns'

/** The settings namespace carrying the feature flag. */
export const SETTINGS_NAMESPACE = 'cc-edit-recovery-hint' as SettingsNamespace

/** Resolved settings shape. */
export interface RecoveryHintSettings {
  enabled: boolean
}

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/** Inner object shape (kebab keys). Absence resolves to defaults via schemastery. */
const SettingsObject = z.object({
  enabled: z.boolean().default(false),
})

/**
 * Namespace schema. Wrapped in the z.const(undefined) union (receipt.ts /
 * post-edit-verify convention) so a genuinely absent namespace value stays
 * absent instead of materializing defaults into the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>> =
  opt(SettingsObject) as unknown as z<Record<string, unknown>>

/** Ship-dark default: the hint is opt-in. */
export const DEFAULT_RECOVERY_HINT_SETTINGS: RecoveryHintSettings = { enabled: false }

/**
 * Register the settings namespace (for /config UX and validation only —
 * the listener reads the raw user file). Returns the live reader, or
 * `undefined` when the host has no settings provider.
 */
export function registerSettings(ctx: Context): (() => RecoveryHintSettings) | undefined {
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
      if (value === undefined) return DEFAULT_RECOVERY_HINT_SETTINGS
      const resolved = SettingsObject(value as unknown as Record<string, never>) as unknown as Record<string, unknown>
      return { enabled: resolved.enabled as boolean }
    } catch {
      // Malformed live scope → ship-dark defaults; never throw into a hot path.
      return DEFAULT_RECOVERY_HINT_SETTINGS
    }
  }
}

/**
 * Read the enabled flag DIRECTLY from `<dshHome>/settings.json`, bypassing
 * the merged cascade. Fail-soft: absent file, parse error, or a malformed
 * section yields the ship-dark default (false). Project-scope values are
 * never read — invisible, not refused.
 */
export async function readUserEnabled(dshHome: string): Promise<boolean> {
  let text: string
  try {
    text = await readFile(join(dshHome, 'settings.json'), 'utf8')
  } catch {
    return false
  }
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return false
  }
  if (typeof root !== 'object' || root === null) return false
  const section = (root as Record<string, unknown>)[SETTINGS_NAMESPACE]
  if (typeof section !== 'object' || section === null) return false
  return (section as Record<string, unknown>).enabled === true
}
