/**
 * Settings for the retry-attendant (design doc
 * docs/plans/2026-10-09-verify-before-retry.md §3.5): one kebab-case
 * namespace, ship-dark (`enabled` defaults false). Two halves, mirroring
 * post-edit-verify/turn-rules:
 *
 * 1. namespace registration via `@dsh-cc/settings-ns` (for /config UX and
 *    validation only);
 * 2. a RAW user-layer read of `<dshHome>/settings.json` per use — hot reload
 *    for free, and project-scope values are invisible. Fail-soft everywhere:
 *    absent file, parse error, or malformed section yields ship-dark defaults.
 *
 * @module
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings-provider'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings-ns'

/** The settings namespace carrying the feature flags. */
export const SETTINGS_NAMESPACE = 'retry-attendant' as SettingsNamespace

/** Resolved settings shape (camelCase internal; config keys are kebab). */
export interface RetrySettings {
  enabled: boolean
  guidance: boolean
  escalate: boolean
  expireMinutes: number
}

/** Ship-dark defaults (§3.5): the whole feature is opt-in. */
export const DEFAULT_RETRY_SETTINGS: RetrySettings = {
  enabled: false,
  guidance: true,
  escalate: true,
  expireMinutes: 10,
}

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/** Inner object shape (kebab keys). Absence resolves to defaults via schemastery. */
const SettingsObject = z.object({
  enabled: z.boolean().default(false),
  guidance: z.boolean().default(true),
  escalate: z.boolean().default(true),
  'expire-minutes': z.number().default(10),
})

/**
 * Namespace schema. Wrapped in the z.const(undefined) union (receipt.ts
 * convention) so a genuinely absent namespace value stays absent instead of
 * materializing defaults into the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>> =
  opt(SettingsObject) as unknown as z<Record<string, unknown>>

/** Map the kebab schema shape onto the camelCase internal shape. */
export function resolveSettings(section: Record<string, unknown>): RetrySettings {
  const resolved = SettingsObject(section as unknown as Record<string, never>) as unknown as Record<string, unknown>
  return {
    enabled: resolved.enabled as boolean,
    guidance: resolved.guidance as boolean,
    escalate: resolved.escalate as boolean,
    expireMinutes: resolved['expire-minutes'] as number,
  }
}

/**
 * Register the settings namespace (for /config UX and validation only — the
 * listeners read the raw user file per use). Returns the live reader, or
 * `undefined` when the host has no settings provider.
 */
export function registerRetrySettings(ctx: Context): (() => RetrySettings) | undefined {
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
      return value === undefined ? DEFAULT_RETRY_SETTINGS : resolveSettings(value)
    } catch {
      // Malformed live scope → ship-dark defaults; never throw into a hot path.
      return DEFAULT_RETRY_SETTINGS
    }
  }
}

/**
 * Read retry-attendant settings DIRECTLY from `<dshHome>/settings.json`,
 * bypassing the merged cascade (post-edit-verify §3.4 idiom). Fail-soft:
 * absent file, parse error, or a malformed section yields the ship-dark
 * defaults. Project-scope values are never read — invisible, not refused.
 */
export async function readUserSettings(dshHome: string): Promise<RetrySettings> {
  let text: string
  try {
    text = await readFile(join(dshHome, 'settings.json'), 'utf8')
  } catch {
    return DEFAULT_RETRY_SETTINGS
  }
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return DEFAULT_RETRY_SETTINGS
  }
  if (typeof root !== 'object' || root === null) return DEFAULT_RETRY_SETTINGS
  const section = (root as Record<string, unknown>)[SETTINGS_NAMESPACE]
  if (typeof section !== 'object' || section === null) return DEFAULT_RETRY_SETTINGS
  try {
    return resolveSettings(section as Record<string, unknown>)
  } catch {
    return DEFAULT_RETRY_SETTINGS
  }
}
