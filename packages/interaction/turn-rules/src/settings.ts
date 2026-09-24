/**
 * Settings for the turn-rules engine (plan docs/plans/2026-09-23-turn-rules.md
 * §4.8), two halves — same split as edit-recovery-hint:
 *
 * 1. namespace registration via `@dsh-cc/settings-ns` (schema uses the kebab
 *    keys users author in settings.json), for /config UX and validation only;
 * 2. a RAW user-layer read of `<dshHome>/settings.json` that bypasses the
 *    merged cascade entirely, re-read per use (a few KB) — free hot reload.
 *
 * @module
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings-ns'

/** The settings namespace carrying the engine flags. */
export const SETTINGS_NAMESPACE = 'cc-turn-rules' as SettingsNamespace

/** Resolved settings shape. */
export interface TurnRulesSettings {
  enabled: boolean
  maxResultBytes: number
  regexCacheSize: number
  judgedEnabled: boolean
}

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/** Inner object shape (kebab keys). Absence resolves to defaults via schemastery. */
const SettingsObject = z.object({
  enabled: z.boolean().default(true),
  'max-result-bytes': z.number().default(200_000),
  'regex-cache-size': z.number().default(64),
  judged: opt(z.object({ enabled: z.boolean().default(false) })),
})

/**
 * Namespace schema. Wrapped in the z.const(undefined) union (post-edit-verify
 * convention) so a genuinely absent namespace value stays absent instead of
 * materializing defaults into the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>> =
  opt(SettingsObject) as unknown as z<Record<string, unknown>>

/** Ship-on defaults: zero trigger-bearing rules exist by default, so enabling is behavior-neutral. */
export const DEFAULT_TURN_RULES_SETTINGS: TurnRulesSettings = {
  enabled: true,
  maxResultBytes: 200_000,
  regexCacheSize: 64,
  judgedEnabled: false,
}

/**
 * Register the settings namespace (for /config UX and validation only —
 * the listeners read the raw user file). Returns the live reader, or
 * `undefined` when the host has no settings provider.
 */
export function registerSettings(ctx: Context): (() => TurnRulesSettings) | undefined {
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
      if (value === undefined) return DEFAULT_TURN_RULES_SETTINGS
      return resolveSection(value as unknown as Record<string, unknown>)
    } catch {
      // Malformed live scope → ship defaults; never throw into a hot path.
      return DEFAULT_TURN_RULES_SETTINGS
    }
  }
}

/** Resolve one raw section into the settings shape with defaults. */
function resolveSection(section: Record<string, unknown>): TurnRulesSettings {
  const resolved = SettingsObject(section as unknown as Record<string, never>) as unknown as Record<string, unknown>
  const judged = resolved.judged as Record<string, unknown> | undefined
  return {
    enabled: resolved.enabled as boolean,
    maxResultBytes: resolved['max-result-bytes'] as number,
    regexCacheSize: resolved['regex-cache-size'] as number,
    judgedEnabled: judged?.enabled === true,
  }
}

/**
 * Read the settings DIRECTLY from `<dshHome>/settings.json`, bypassing the
 * merged cascade. Fail-soft: absent file, parse error, or a malformed section
 * yields the ship defaults. Project scope is never read — invisible, not refused.
 */
export async function readUserSettings(dshHome: string): Promise<TurnRulesSettings> {
  let text: string
  try {
    text = await readFile(join(dshHome, 'settings.json'), 'utf8')
  } catch {
    return DEFAULT_TURN_RULES_SETTINGS
  }
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return DEFAULT_TURN_RULES_SETTINGS
  }
  if (typeof root !== 'object' || root === null) return DEFAULT_TURN_RULES_SETTINGS
  const section = (root as Record<string, unknown>)[SETTINGS_NAMESPACE]
  if (typeof section !== 'object' || section === null) return DEFAULT_TURN_RULES_SETTINGS
  try {
    return resolveSection(section as Record<string, unknown>)
  } catch {
    return DEFAULT_TURN_RULES_SETTINGS
  }
}
