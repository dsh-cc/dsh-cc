/**
 * Settings for skill-usage telemetry (design
 * docs/plans/2026-10-09-skill-lifecycle-usage-gates.md §3.5), dual-half
 * pattern (advisor-watchdog precedent):
 *
 * 1. namespace registration via `@dsh-cc/settings-ns` (kebab keys) — the
 *    cascade read serves /config UX and the rollup-time knobs (slice C);
 * 2. a RAW user-layer read of `<dshHome>/settings.json` re-read per matched
 *    skill-load event, so a hot toggle never waits on cascade timing.
 *
 * Limitation (stated, same as the watchdog): the raw read sees the USER layer
 * only — project/repo cascade layers are invisible to it.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings-provider'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings-ns'

/** The settings namespace carrying the skill-usage flags. */
export const SETTINGS_NAMESPACE = 'cc-skill-usage' as SettingsNamespace

/** Resolved settings shape. */
export interface SkillUsageSettings {
  enabled: boolean
  rollupStaleHours: number
  neverLoadedDays: number
}

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/** Inner object shape (kebab keys). Absence resolves to defaults via schemastery. */
const SettingsObject = z.object({
  enabled: z.boolean().default(true),
  'rollup-stale-hours': z.number().min(1).max(24 * 30).default(24),
  'never-loaded-days': z.number().min(1).default(30),
})

/**
 * Namespace schema. Wrapped in the z.const(undefined) union (watchdog
 * convention) so a genuinely absent namespace value stays absent instead of
 * materializing defaults into the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>> =
  opt(SettingsObject) as unknown as z<Record<string, unknown>>

/** Ship defaults: telemetry on, rollup daily, 30d never-loaded gate. */
export const DEFAULT_SKILL_USAGE_SETTINGS: SkillUsageSettings = {
  enabled: true,
  rollupStaleHours: 24,
  neverLoadedDays: 30,
}

/**
 * Register the settings namespace (for /config UX, validation, and the
 * rollup-time cascade knobs). Returns the live reader, or `undefined` when
 * the host has no settings provider.
 */
export function registerSettings(ctx: Context): (() => SkillUsageSettings) | undefined {
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
      if (value === undefined) return DEFAULT_SKILL_USAGE_SETTINGS
      return resolveSection(value as unknown as Record<string, unknown>)
    } catch {
      // Malformed live scope → ship defaults; never throw into a hot path.
      return DEFAULT_SKILL_USAGE_SETTINGS
    }
  }
}

/** Resolve one raw section into the settings shape with defaults. */
function resolveSection(section: Record<string, unknown>): SkillUsageSettings {
  const resolved = SettingsObject(section as unknown as Record<string, never>) as unknown as Record<string, unknown>
  const asInt = (value: unknown, fallback: number): number => {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
    return n
  }
  return {
    enabled: resolved.enabled as boolean,
    rollupStaleHours: asInt(resolved['rollup-stale-hours'], 24),
    neverLoadedDays: asInt(resolved['never-loaded-days'], 30),
  }
}

/**
 * SYNCHRONOUS raw read of `<dshHome>/settings.json`, bypassing the merged
 * cascade — the per-matched-event half of the dual-half pattern: only runs
 * after a skill-load match (rare), so a sync read is fine and keeps the
 * listeners synchronous. Fail-soft: absent file, parse error, or malformed
 * section yields the ship defaults. User layer only — project/repo layers
 * are invisible (same limitation as the advisor watchdog).
 */
export function readUserSettingsSync(dshHome: string): SkillUsageSettings {
  let text: string
  try {
    text = readFileSync(join(dshHome, 'settings.json'), 'utf8')
  } catch {
    return DEFAULT_SKILL_USAGE_SETTINGS
  }
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return DEFAULT_SKILL_USAGE_SETTINGS
  }
  if (typeof root !== 'object' || root === null) return DEFAULT_SKILL_USAGE_SETTINGS
  const section = (root as Record<string, unknown>)[SETTINGS_NAMESPACE]
  if (typeof section !== 'object' || section === null) return DEFAULT_SKILL_USAGE_SETTINGS
  try {
    return resolveSection(section as Record<string, unknown>)
  } catch {
    return DEFAULT_SKILL_USAGE_SETTINGS
  }
}
