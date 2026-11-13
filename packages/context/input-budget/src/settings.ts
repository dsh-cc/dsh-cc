/**
 * Settings for the per-step input budget governor (plan doc
 * `docs/plans/2026-11-12-per-step-input-budget-governor.md` §"Settings —
 * `cc-input-budget`"), two halves — the completion-gate / input-ledger
 * dual-half pattern:
 *
 * 1. namespace registration via `@dsh-cc/settings/ns` (kebab keys, for /config
 *    UX and validation only);
 * 2. a RAW user-layer read of `<dshHome>/settings.json` re-read per gate
 *    invocation, so a hot toggle applies on the next step without a restart.
 *
 * Four-surface default discipline: the schema `.default()`s, the
 * {@link DEFAULT_INPUT_BUDGET_SETTINGS} constants, the fail-soft raw reader
 * (absent or malformed file, out-of-bounds integers → defaults or bounds), and
 * the wiring fallback in the slice-5 mount all agree. No settings file means
 * the defaults, which means `mode: 'observe'` — the governor records decisions
 * and changes nothing.
 *
 * @module @dsh-cc/input-budget/settings
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings/ns'
import type { GovernorSettings } from './core.ts'

/** The settings namespace carrying the governor knobs. */
export const SETTINGS_NAMESPACE = 'cc-input-budget' as SettingsNamespace

/** Bounds of `enter-budget-bytes`. */
export const MIN_ENTER_BUDGET_BYTES = 4096
export const MAX_ENTER_BUDGET_BYTES = 262_144

/** Bounds of `advisory-budget-bytes`. */
export const MIN_ADVISORY_BUDGET_BYTES = 512
export const MAX_ADVISORY_BUDGET_BYTES = 65_536

/** Bounds of `memory-budget-bytes`. */
export const MIN_MEMORY_BUDGET_BYTES = 1024
export const MAX_MEMORY_BUDGET_BYTES = 131_072

/** Bounds of `defer-ttl-steps`. */
export const MIN_DEFER_TTL_STEPS = 1
export const MAX_DEFER_TTL_STEPS = 16

/** The two governance modes. A flip to `enforce` starts with an empty defer queue. */
export type InputBudgetMode = 'observe' | 'enforce'

/** Resolved settings shape (kebab keys). */
export interface InputBudgetSettings extends GovernorSettings {
  /** Whether the governor runs at all; disabling is a full no-op, not a passthrough trim. */
  enabled: boolean
  mode: InputBudgetMode
}

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/** Mode schema: exactly two spellings, no free-form fallback. */
const ModeSchema = z.union([z.const('observe'), z.const('enforce')])

/** Inner object shape (kebab keys). Absence resolves to defaults via schemastery. */
const SettingsObject = z.object({
  enabled: z.boolean().default(true),
  mode: ModeSchema.default('observe'),
  'enter-budget-bytes': z.number().min(MIN_ENTER_BUDGET_BYTES).max(MAX_ENTER_BUDGET_BYTES)
    .default(24_576),
  'advisory-budget-bytes': z.number().min(MIN_ADVISORY_BUDGET_BYTES).max(MAX_ADVISORY_BUDGET_BYTES)
    .default(8192),
  'memory-budget-bytes': z.number().min(MIN_MEMORY_BUDGET_BYTES).max(MAX_MEMORY_BUDGET_BYTES)
    .default(16_384),
  'defer-ttl-steps': z.number().min(MIN_DEFER_TTL_STEPS).max(MAX_DEFER_TTL_STEPS).default(3),
})

/**
 * Namespace schema. Wrapped in the z.const(undefined) union (turn-rules
 * convention) so a genuinely absent namespace value stays absent instead of
 * materializing defaults into the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>> =
  opt(SettingsObject) as unknown as z<Record<string, unknown>>

/**
 * Ship defaults: enabled, observe mode, and budgets sized from the ledger's
 * observe-mode plan — 24 KiB enter, 8 KiB advisory, 16 KiB memory (recall
 * bodies), 3-invocation defer TTL.
 */
export const DEFAULT_INPUT_BUDGET_SETTINGS: InputBudgetSettings = {
  enabled: true,
  mode: 'observe',
  'enter-budget-bytes': 24_576,
  'advisory-budget-bytes': 8192,
  'memory-budget-bytes': 16_384,
  'defer-ttl-steps': 3,
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

/** Resolve one raw mode setting: anything but `'enforce'` resolves to `'observe'`. */
function modeOf(value: unknown, fallback: InputBudgetMode): InputBudgetMode {
  return value === 'enforce' || value === 'observe' ? value : fallback
}

/**
 * Resolve one raw section into the settings shape. The schema above is the
 * validation surface (/config UX); the raw reader must stay fail-soft, so it
 * clamps out-of-bounds integers into the documented bounds instead of rejecting
 * the whole section.
 */
function resolveSection(section: Record<string, unknown>): InputBudgetSettings {
  return {
    enabled: booleanOf(section.enabled, DEFAULT_INPUT_BUDGET_SETTINGS.enabled),
    mode: modeOf(section.mode, DEFAULT_INPUT_BUDGET_SETTINGS.mode),
    'enter-budget-bytes': boundedInt(
      section['enter-budget-bytes'],
      DEFAULT_INPUT_BUDGET_SETTINGS['enter-budget-bytes'],
      MIN_ENTER_BUDGET_BYTES,
      MAX_ENTER_BUDGET_BYTES,
    ),
    'advisory-budget-bytes': boundedInt(
      section['advisory-budget-bytes'],
      DEFAULT_INPUT_BUDGET_SETTINGS['advisory-budget-bytes'],
      MIN_ADVISORY_BUDGET_BYTES,
      MAX_ADVISORY_BUDGET_BYTES,
    ),
    'memory-budget-bytes': boundedInt(
      section['memory-budget-bytes'],
      DEFAULT_INPUT_BUDGET_SETTINGS['memory-budget-bytes'],
      MIN_MEMORY_BUDGET_BYTES,
      MAX_MEMORY_BUDGET_BYTES,
    ),
    'defer-ttl-steps': boundedInt(
      section['defer-ttl-steps'],
      DEFAULT_INPUT_BUDGET_SETTINGS['defer-ttl-steps'],
      MIN_DEFER_TTL_STEPS,
      MAX_DEFER_TTL_STEPS,
    ),
  }
}

/**
 * Register the settings namespace (for /config UX and validation only — the
 * listener reads the raw user file per gate invocation).
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
function parseSettings(text: string): InputBudgetSettings {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return DEFAULT_INPUT_BUDGET_SETTINGS
  }
  if (typeof root !== 'object' || root === null) return DEFAULT_INPUT_BUDGET_SETTINGS
  const section = (root as Record<string, unknown>)[SETTINGS_NAMESPACE]
  if (typeof section !== 'object' || section === null) return DEFAULT_INPUT_BUDGET_SETTINGS
  try {
    return resolveSection(section as Record<string, unknown>)
  } catch {
    return DEFAULT_INPUT_BUDGET_SETTINGS
  }
}

/**
 * Read the settings DIRECTLY from `<dshHome>/settings.json`, bypassing the
 * merged cascade. Fail-soft: an absent file, parse error, or malformed section
 * yields {@link DEFAULT_INPUT_BUDGET_SETTINGS} (observe mode).
 * @param dshHome - the harness home directory root.
 */
export async function readUserSettings(dshHome: string): Promise<InputBudgetSettings> {
  let text: string
  try {
    text = await readFile(join(dshHome, 'settings.json'), 'utf8')
  } catch {
    return DEFAULT_INPUT_BUDGET_SETTINGS
  }
  return parseSettings(text)
}

/**
 * SYNCHRONOUS raw read of `<dshHome>/settings.json` — the hot-path half of the
 * dual-half pattern: the listener re-reads per gate invocation, so settings
 * hot-toggle takes effect on the next step without a restart. Same fail-soft
 * semantics as {@link readUserSettings}.
 * @param dshHome - the harness home directory root.
 */
export function readUserSettingsSync(dshHome: string): InputBudgetSettings {
  let text: string
  try {
    text = readFileSync(join(dshHome, 'settings.json'), 'utf8')
  } catch {
    return DEFAULT_INPUT_BUDGET_SETTINGS
  }
  return parseSettings(text)
}
