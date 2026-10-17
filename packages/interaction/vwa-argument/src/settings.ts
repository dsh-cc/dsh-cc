/**
 * Settings schema for namespace `vwa-argument` (design
 * docs/plans/2026-10-16-vwa-evidence-argument.md §13). All defaults for the
 * semantic feature are OFF (`semantic-enabled: false`): lane 2 changes
 * nothing until explicitly enabled.
 *
 * Same shape as vwa-evidence's settings.ts: `registerNamespaceSafe` +
 * absence-preserving union for the /config cascade, plus a synchronous raw
 * hot-read of `<dshHome>/settings.json` (fail-soft to ship defaults) for the
 * evaluate-time half. Registration is UX-only; hot paths re-read the raw file.
 *
 * @module @dsh-cc/vwa-argument/settings
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings-provider'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings-ns'

/** The settings namespace carrying the lane-2 review flags (§13). */
export const SETTINGS_NAMESPACE = 'vwa-argument'

/** Resolved settings shape (flat kebab keys, §13 table). */
export interface VwaArgumentSettings {
  'semantic-enabled': boolean
  'semantic-mode': 'draft' | 'reviewed'
  /** Model ALIAS (never a concrete id) the reviewer routes through (ccModelRoutes / resolveAlias). */
  'review-alias': string
  'review-max-calls-per-run': number
  'review-max-input-tokens-per-run': number
  'review-max-output-tokens-per-run': number
  'review-max-output-tokens-per-call': number
  'review-max-wall-ms': number
  'review-call-timeout-ms': number
  'review-concurrency': number
  'review-max-artifact-chars': number
  'review-max-context-chars-per-task': number
  'project-max-entities': number
  'repair-max-rounds-per-artifact-turn': number
}

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/** Inner object shape (kebab keys, §13 defaults and ranges). */
const SettingsObject = z.object({
  'semantic-enabled': z.boolean().default(false),
  'semantic-mode': z.union([z.const('draft'), z.const('reviewed')]).default('draft'),
  'review-alias': z.string().default('sonnet'),
  'review-max-calls-per-run': z.number().step(1).min(1).max(200).default(40),
  'review-max-input-tokens-per-run': z.number().step(1).min(1000).max(1_000_000).default(160_000),
  'review-max-output-tokens-per-run': z.number().step(1).min(1000).max(200_000).default(24_000),
  'review-max-output-tokens-per-call': z.number().step(1).min(256).max(16_000).default(3000),
  'review-max-wall-ms': z.number().step(1).min(1000).max(900_000).default(180_000),
  'review-call-timeout-ms': z.number().step(1).min(1000).max(120_000).default(45_000),
  'review-concurrency': z.number().step(1).min(1).max(4).default(2),
  'review-max-artifact-chars': z.number().step(1).min(1000).default(120_000),
  'review-max-context-chars-per-task': z.number().step(1).min(1000).default(48_000),
  'project-max-entities': z.number().step(1).min(1).default(10_000),
  // Fixed cap per design (§13); the schema range keeps a sane guard only.
  'repair-max-rounds-per-artifact-turn': z.number().step(1).min(0).max(10).default(1),
})

/**
 * Namespace schema, wrapped in the z.const(undefined) union (turn-rules
 * convention) so a genuinely absent namespace value stays absent instead of
 * materializing defaults into the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>> = opt(SettingsObject) as unknown as z<Record<string, unknown>>

/** Ship defaults (§13): semantic OFF, draft mode, the review budget table. */
export const DEFAULT_VWA_ARGUMENT_SETTINGS: VwaArgumentSettings = {
  'semantic-enabled': false,
  'semantic-mode': 'draft',
  'review-alias': 'sonnet',
  'review-max-calls-per-run': 40,
  'review-max-input-tokens-per-run': 160_000,
  'review-max-output-tokens-per-run': 24_000,
  'review-max-output-tokens-per-call': 3000,
  'review-max-wall-ms': 180_000,
  'review-call-timeout-ms': 45_000,
  'review-concurrency': 2,
  'review-max-artifact-chars': 120_000,
  'review-max-context-chars-per-task': 48_000,
  'project-max-entities': 10_000,
  'repair-max-rounds-per-artifact-turn': 1,
}

/**
 * Register the settings namespace (§13). UX-only — this slice has no
 * listeners, so the registration just seeds /config validation; a later
 * slice's runner reads the raw file hot (§13).
 */
export function registerSettings(ctx: Context): void {
  try {
    const settings = ctx.get('settings')
    if (settings === undefined) return
    registerNamespaceSafe<Record<string, unknown>>(
      ctx,
      SETTINGS_NAMESPACE as SettingsNamespace,
      SettingsSchema as unknown as z<Record<string, unknown>>,
    )
  } catch {
    // Registration is UX-only; an absent settings service must never break mounting.
  }
}

/** Clamp/validate one raw section into the settings shape (fail-soft per key). */
function resolveSection(section: Record<string, unknown>): VwaArgumentSettings {
  const defaults = DEFAULT_VWA_ARGUMENT_SETTINGS
  const resolved = SettingsObject(section as unknown as Record<string, never>) as unknown as Record<string, unknown>
  const num = (key: keyof VwaArgumentSettings): number => {
    const value = resolved[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : (defaults[key] as number)
  }
  return {
    'semantic-enabled': resolved['semantic-enabled'] === true,
    'semantic-mode': resolved['semantic-mode'] === 'reviewed' ? 'reviewed' : 'draft',
    'review-alias':
      typeof resolved['review-alias'] === 'string' && resolved['review-alias'].length > 0
        ? resolved['review-alias']
        : defaults['review-alias'],
    'review-max-calls-per-run': num('review-max-calls-per-run'),
    'review-max-input-tokens-per-run': num('review-max-input-tokens-per-run'),
    'review-max-output-tokens-per-run': num('review-max-output-tokens-per-run'),
    'review-max-output-tokens-per-call': num('review-max-output-tokens-per-call'),
    'review-max-wall-ms': num('review-max-wall-ms'),
    'review-call-timeout-ms': num('review-call-timeout-ms'),
    'review-concurrency': num('review-concurrency'),
    'review-max-artifact-chars': num('review-max-artifact-chars'),
    'review-max-context-chars-per-task': num('review-max-context-chars-per-task'),
    'project-max-entities': num('project-max-entities'),
    'repair-max-rounds-per-artifact-turn': num('repair-max-rounds-per-artifact-turn'),
  }
}

/**
 * SYNCHRONOUS raw read of `<dshHome>/settings.json` — the hot-read half of
 * the dual-half pattern (vwa-evidence settings.ts idiom). Fail-soft: absent
 * file, parse error, or malformed section yields the ship defaults (OFF).
 */
export function readUserSettingsSync(dshHome: string): VwaArgumentSettings {
  let text: string
  try {
    text = readFileSync(join(dshHome, 'settings.json'), 'utf8')
  } catch {
    return DEFAULT_VWA_ARGUMENT_SETTINGS
  }
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return DEFAULT_VWA_ARGUMENT_SETTINGS
  }
  if (typeof root !== 'object' || root === null) return DEFAULT_VWA_ARGUMENT_SETTINGS
  const section = (root as Record<string, unknown>)[SETTINGS_NAMESPACE]
  if (typeof section !== 'object' || section === null) return DEFAULT_VWA_ARGUMENT_SETTINGS
  try {
    return resolveSection(section as Record<string, unknown>)
  } catch {
    return DEFAULT_VWA_ARGUMENT_SETTINGS
  }
}
