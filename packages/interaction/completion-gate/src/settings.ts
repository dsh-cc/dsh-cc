/**
 * Settings for the completion gate (plan
 * docs/plans/2026-10-09-runtime-verified-completion.md §3.5), two halves —
 * the advisor-watchdog dual-half pattern
 * (packages/interaction/advisor-watchdog/src/settings.ts):
 *
 * 1. namespace registration via `@dsh-cc/settings-ns` (kebab keys, for /config
 *    UX and validation only);
 * 2. a RAW user-layer read of `<dshHome>/settings.json` re-read per use
 *    (sync reader on the trigger side — the post-execute handler must run
 *    synchronously up to hash capture).
 *
 * DEFAULT OFF (`cc-completion-gate.enabled` false — dogfood-first, §3.5).
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings-provider'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings-ns'

/** The settings namespace carrying the gate flags. */
export const SETTINGS_NAMESPACE = 'cc-completion-gate' as SettingsNamespace

/** Resolved settings shape. */
export interface GateSettings {
  enabled: boolean
  'nudges-per-session': number
}

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/** Inner object shape (kebab keys). Absence resolves to defaults via schemastery. */
const SettingsObject = z.object({
  enabled: z.boolean().default(false),
  'nudges-per-session': z.number().min(0).max(64).default(1),
})

/**
 * Namespace schema. Wrapped in the z.const(undefined) union (turn-rules
 * convention) so a genuinely absent namespace value stays absent instead of
 * materializing defaults into the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>> =
  opt(SettingsObject) as unknown as z<Record<string, unknown>>

/** Ship-dark defaults (§3.5): enabled false, one nudge per session. */
export const DEFAULT_GATE_SETTINGS: GateSettings = {
  enabled: false,
  'nudges-per-session': 1,
}

/** Resolve one raw section into the settings shape with defaults. */
function resolveSection(section: Record<string, unknown>): GateSettings {
  const resolved = SettingsObject(section as unknown as Record<string, never>) as unknown as Record<string, unknown>
  const asInt = (value: unknown, fallback: number): number => {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
    return n
  }
  return {
    enabled: resolved.enabled as boolean,
    'nudges-per-session': asInt(resolved['nudges-per-session'], 1),
  }
}

/**
 * Register the settings namespace (for /config UX and validation only —
 * the listeners read the raw user file per use).
 */
export function registerSettings(ctx: Context): void {
  const settings = ctx.get('settings') as object | undefined
  if (settings === undefined) return
  registerNamespaceSafe<Record<string, unknown>>(
    ctx,
    SETTINGS_NAMESPACE,
    SettingsSchema as unknown as z<Record<string, unknown>>,
  )
}

/** Parse a raw `<dshHome>/settings.json` text into GateSettings, fail-soft. */
function parseSettings(text: string): GateSettings {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return DEFAULT_GATE_SETTINGS
  }
  if (typeof root !== 'object' || root === null) return DEFAULT_GATE_SETTINGS
  const section = (root as Record<string, unknown>)[SETTINGS_NAMESPACE]
  if (typeof section !== 'object' || section === null) return DEFAULT_GATE_SETTINGS
  try {
    return resolveSection(section as Record<string, unknown>)
  } catch {
    return DEFAULT_GATE_SETTINGS
  }
}

/**
 * Read the settings DIRECTLY from `<dshHome>/settings.json`, bypassing the
 * merged cascade. Fail-soft: absent file, parse error, or a malformed section
 * yields the ship defaults.
 */
export async function readUserSettings(dshHome: string): Promise<GateSettings> {
  let text: string
  try {
    text = await readFile(join(dshHome, 'settings.json'), 'utf8')
  } catch {
    return DEFAULT_GATE_SETTINGS
  }
  return parseSettings(text)
}

/**
 * SYNCHRONOUS raw read of `<dshHome>/settings.json` — the hot-path half of
 * the dual-half pattern (§3.5): both listeners re-read per event so settings
 * hot-toggle takes effect on the next event without a restart. Same
 * fail-soft semantics as {@link readUserSettings}.
 */
export function readUserSettingsSync(dshHome: string): GateSettings {
  let text: string
  try {
    text = readFileSync(join(dshHome, 'settings.json'), 'utf8')
  } catch {
    return DEFAULT_GATE_SETTINGS
  }
  return parseSettings(text)
}
