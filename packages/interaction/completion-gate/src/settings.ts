/**
 * Settings for the completion gate (plan
 * docs/plans/2026-10-09-runtime-verified-completion.md §3.5), two halves —
 * the advisor-watchdog dual-half pattern
 * (packages/interaction/advisor-watchdog/src/settings.ts):
 *
 * 1. namespace registration via `@dsh-cc/settings/ns` (kebab keys, for /config
 *    UX and validation only);
 * 2. a RAW user-layer read of `<dshHome>/settings.json` re-read per use
 *    (sync reader on the trigger side — the post-execute handler must run
 *    synchronously up to hash capture).
 *
 * DEFAULT ON since 2026-11-11 (promoted from ship-dark after the production
 * dogfood run; opt out with `cc-completion-gate.enabled: false`).
 *
 * Enforce mode (plan docs/plans/2026-11-17-completion-gate-enforce-mode.md
 * §3.1) adds two keys: `mode` (`nudge` default | `enforce`) and
 * `enforce-max-cycles` (1–10, default 3). The /config schema face carries the
 * const union + min/max; the RAW read path validates the legacy keys only and
 * coerces the new keys per-key, so an invalid new value can never fall the
 * whole section back to the defaults.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings/ns'

/** The settings namespace carrying the gate flags. */
export const SETTINGS_NAMESPACE = 'cc-completion-gate' as SettingsNamespace

/** Gate mode (§3.1 of the enforce-mode plan): advisory `nudge` or bounded `enforce`. */
export type GateMode = 'nudge' | 'enforce'

/** Resolved settings shape. */
export interface GateSettings {
  enabled: boolean
  'nudges-per-session': number
  mode: GateMode
  'enforce-max-cycles': number
}

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/** Enforce cycle bounds (§3.1): the schema face and the raw clamp agree. */
const MIN_ENFORCE_CYCLES = 1
const MAX_ENFORCE_CYCLES = 10
const DEFAULT_ENFORCE_MAX_CYCLES = 3

/**
 * Inner object shape (kebab keys) for the `/config` schema face. Absence
 * resolves to defaults via schemastery. This object is used ONLY for
 * namespace registration — the raw read path validates the legacy keys
 * separately (`LegacySettingsObject`) so an invalid new key can never throw
 * the whole section back to the defaults (§3.1 r2).
 */
const SettingsObject = z.object({
  enabled: z.boolean().default(true),
  'nudges-per-session': z.number().min(0).max(64).default(1),
  // Schemastery has no `z.enum`; the const union is the idiom (advisor).
  mode: z.union([z.const('nudge'), z.const('enforce')]).default('nudge'),
  'enforce-max-cycles': z.number().min(MIN_ENFORCE_CYCLES).max(MAX_ENFORCE_CYCLES).default(DEFAULT_ENFORCE_MAX_CYCLES),
})

/**
 * RAW-path validator: the LEGACY keys only (§3.1 r2). The new keys are
 * coerced per-key from the raw section object instead, so
 * `{ enabled: false, mode: 'typo' }` keeps `enabled: false` — a whole-section
 * fallback would silently re-enable the gate.
 */
const LegacySettingsObject = z.object({
  enabled: z.boolean().default(true),
  'nudges-per-session': z.number().min(0).max(64).default(1),
})

/**
 * Namespace schema. Wrapped in the z.const(undefined) union (turn-rules
 * convention) so a genuinely absent namespace value stays absent instead of
 * materializing defaults into the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>> =
  opt(SettingsObject) as unknown as z<Record<string, unknown>>

/**
 * Promoted defaults (default ON since 2026-11-11): one nudge per session.
 * `mode` stays `nudge` — enforce is opt-in (the default flip is a deliberate
 * follow-up after dogfood, §3.1).
 */
export const DEFAULT_GATE_SETTINGS: GateSettings = {
  enabled: true,
  'nudges-per-session': 1,
  mode: 'nudge',
  'enforce-max-cycles': DEFAULT_ENFORCE_MAX_CYCLES,
}

/** Per-key `mode` coercion (§3.1): anything but 'enforce' is nudge. */
function coerceMode(raw: unknown): GateMode {
  return raw === 'enforce' ? 'enforce' : 'nudge'
}

/** Per-key `enforce-max-cycles` coercion (§3.1): trunc, clamp to [1, 10], else 3. */
function coerceMaxCycles(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_ENFORCE_MAX_CYCLES
  return Math.min(MAX_ENFORCE_CYCLES, Math.max(MIN_ENFORCE_CYCLES, Math.trunc(raw)))
}

/**
 * Resolve one raw section into the settings shape with defaults. The legacy
 * keys are validated as a unit (a throw falls back to the legacy defaults
 * LOCALLY, never to the whole section); the two new keys are always coerced
 * per-key from the RAW section object, including on that legacy-throw path
 * (§3.1 r2).
 */
function resolveSection(section: Record<string, unknown>): GateSettings {
  let legacy: Record<string, unknown>
  try {
    legacy = LegacySettingsObject(section as unknown as Record<string, never>) as unknown as Record<string, unknown>
  } catch {
    legacy = {
      enabled: DEFAULT_GATE_SETTINGS.enabled,
      'nudges-per-session': DEFAULT_GATE_SETTINGS['nudges-per-session'],
    }
  }
  const asInt = (value: unknown, fallback: number): number => {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
    return n
  }
  return {
    enabled: legacy.enabled as boolean,
    'nudges-per-session': asInt(legacy['nudges-per-session'], 1),
    mode: coerceMode(section.mode),
    'enforce-max-cycles': coerceMaxCycles(section['enforce-max-cycles']),
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
