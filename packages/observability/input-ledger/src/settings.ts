/**
 * Settings for the per-step input ledger (plan
 * docs/plans/2026-11-12-per-step-input-ledger.md §"Settings — `cc-input-ledger`"),
 * two halves — the completion-gate / advisor-watchdog dual-half pattern:
 *
 * 1. namespace registration via `@dsh-cc/settings/ns` (kebab keys, for /config
 *    UX and validation only);
 * 2. a RAW user-layer read of `<dshHome>/settings.json` re-read per observed
 *    event, so a hot toggle applies on the next event without a restart.
 *
 * Four-surface default discipline: the schema `.default()`s, the
 * {@link DEFAULT_INPUT_LEDGER_SETTINGS} constants, the fail-soft raw reader
 * (absent/malformed file, out-of-bounds integers → defaults or bounds), and
 * the wiring fallback in `mount.ts` all agree.
 *
 * @module @dsh-cc/input-ledger/settings
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings/ns'
import { DEFAULT_MAX_ROWS_PER_FILE } from './sink.ts'

/** The settings namespace carrying the ledger flags. */
export const SETTINGS_NAMESPACE = 'cc-input-ledger' as SettingsNamespace

/** Bounds of `max-sections-per-row`. */
export const MIN_SECTIONS_PER_ROW = 8
export const MAX_SECTIONS_PER_ROW = 256

/** Bounds of `max-rows-per-file`. */
export const MIN_ROWS_PER_FILE = 100
export const MAX_ROWS_PER_FILE = 100_000

/** Resolved settings shape (kebab keys). */
export interface InputLedgerSettings {
  /** Whether new rows are emitted at all; disabling stops future rows, files are never deleted. */
  enabled: boolean
  /** Whether delegated-agent sessions get their own rows. */
  'include-subagents': boolean
  /** Cap on the `sections` array of one assemble row. */
  'max-sections-per-row': number
  /** Row cap per session file before the file rotates to `<file>.1`. */
  'max-rows-per-file': number
}

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/** Inner object shape (kebab keys). Absence resolves to defaults via schemastery. */
const SettingsObject = z.object({
  enabled: z.boolean().default(true),
  'include-subagents': z.boolean().default(true),
  'max-sections-per-row': z.number().min(MIN_SECTIONS_PER_ROW).max(MAX_SECTIONS_PER_ROW)
    .default(64),
  'max-rows-per-file': z.number().min(MIN_ROWS_PER_FILE).max(MAX_ROWS_PER_FILE)
    .default(DEFAULT_MAX_ROWS_PER_FILE),
})

/**
 * Namespace schema. Wrapped in the z.const(undefined) union (turn-rules
 * convention) so a genuinely absent namespace value stays absent instead of
 * materializing defaults into the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>> =
  opt(SettingsObject) as unknown as z<Record<string, unknown>>

/** Ship defaults: observe everything, 64 sections, 2000 rows per file. */
export const DEFAULT_INPUT_LEDGER_SETTINGS: InputLedgerSettings = {
  enabled: true,
  'include-subagents': true,
  'max-sections-per-row': 64,
  'max-rows-per-file': DEFAULT_MAX_ROWS_PER_FILE,
}

/** Truncate a raw integer setting and clamp it into `[min, max]`, fail-soft. */
function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  if (n < min) return min
  if (n > max) return max
  return n
}

/** Resolve one raw boolean setting: a non-boolean falls back to the ship default. */
function booleanOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Resolve one raw section into the settings shape. The schema above is the
 * validation surface (/config UX); the raw reader must stay fail-soft, so it
 * clamps out-of-bounds integers into the documented bounds instead of
 * rejecting the whole section.
 */
function resolveSection(section: Record<string, unknown>): InputLedgerSettings {
  return {
    enabled: booleanOf(section.enabled, DEFAULT_INPUT_LEDGER_SETTINGS.enabled),
    'include-subagents': booleanOf(
      section['include-subagents'],
      DEFAULT_INPUT_LEDGER_SETTINGS['include-subagents'],
    ),
    'max-sections-per-row': boundedInt(
      section['max-sections-per-row'],
      DEFAULT_INPUT_LEDGER_SETTINGS['max-sections-per-row'],
      MIN_SECTIONS_PER_ROW,
      MAX_SECTIONS_PER_ROW,
    ),
    'max-rows-per-file': boundedInt(
      section['max-rows-per-file'],
      DEFAULT_INPUT_LEDGER_SETTINGS['max-rows-per-file'],
      MIN_ROWS_PER_FILE,
      MAX_ROWS_PER_FILE,
    ),
  }
}

/**
 * Register the settings namespace (for /config UX and validation only — the
 * observers read the raw user file per event).
 * @param ctx - context that may carry the settings provider.
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

/** Parse a raw `<dshHome>/settings.json` text into settings, fail-soft. */
function parseSettings(text: string): InputLedgerSettings {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return DEFAULT_INPUT_LEDGER_SETTINGS
  }
  if (typeof root !== 'object' || root === null) return DEFAULT_INPUT_LEDGER_SETTINGS
  const section = (root as Record<string, unknown>)[SETTINGS_NAMESPACE]
  if (typeof section !== 'object' || section === null) return DEFAULT_INPUT_LEDGER_SETTINGS
  try {
    return resolveSection(section as Record<string, unknown>)
  } catch {
    return DEFAULT_INPUT_LEDGER_SETTINGS
  }
}

/**
 * Read the settings DIRECTLY from `<dshHome>/settings.json`, bypassing the
 * merged cascade. Fail-soft: an absent file, parse error, or malformed section
 * yields {@link DEFAULT_INPUT_LEDGER_SETTINGS}.
 * @param dshHome - the harness home directory root.
 */
export async function readUserSettings(dshHome: string): Promise<InputLedgerSettings> {
  let text: string
  try {
    text = await readFile(join(dshHome, 'settings.json'), 'utf8')
  } catch {
    return DEFAULT_INPUT_LEDGER_SETTINGS
  }
  return parseSettings(text)
}

/**
 * SYNCHRONOUS raw read of `<dshHome>/settings.json` — the hot-path half of the
 * dual-half pattern: every observer re-reads per event, so settings
 * hot-toggle takes effect on the next event without a restart. Same fail-soft
 * semantics as {@link readUserSettings}.
 * @param dshHome - the harness home directory root.
 */
export function readUserSettingsSync(dshHome: string): InputLedgerSettings {
  let text: string
  try {
    text = readFileSync(join(dshHome, 'settings.json'), 'utf8')
  } catch {
    return DEFAULT_INPUT_LEDGER_SETTINGS
  }
  return parseSettings(text)
}
