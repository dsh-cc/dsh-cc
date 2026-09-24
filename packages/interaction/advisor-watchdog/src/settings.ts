/**
 * Settings for the advisor watchdog (plan
 * docs/plans/2026-09-23-advisor-watchdog.md §4.9), two halves — the turn-rules
 * dual-half pattern (packages/interaction/turn-rules/src/settings.ts):
 *
 * 1. namespace registration via `@dsh-cc/settings-ns` (kebab keys, for /config
 *    UX and validation only);
 * 2. a RAW user-layer read of `<dshHome>/settings.json` re-read per use, so a
 *    turn never depends on cascade timing.
 *
 * Schemastery has no `z.enum`; enum members are expressed as
 * `z.union([z.const(...), ...])`.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings-ns'

/** The settings namespace carrying the advisor flags. */
export const SETTINGS_NAMESPACE = 'cc-advisor' as SettingsNamespace

/** The severity taxonomy (omp advise-tool.ts:20,62-63, kept verbatim). */
export type Severity = 'nit' | 'concern' | 'blocker'

/** Resolved settings shape. */
export interface AdvisorSettings {
  enabled: boolean
  alias: string
  budget: number
  immuneTurns: number
  sessionCap: number
  severities: readonly Severity[]
  subagents: 'off' | 'on' | string
}

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

const SeverityEnum = z.union([
  z.const('nit'),
  z.const('concern'),
  z.const('blocker'),
]) as unknown as z<Severity>

/** Inner object shape (kebab keys). Absence resolves to defaults via schemastery. */
const SettingsObject = z.object({
  enabled: z.boolean().default(false),
  alias: z.string().default('haiku'),
  // Schemastery's number schema has no .int; integrality is enforced in
  // resolveSection (truncation) — the range bounds are the schema's job.
  budget: z.number().min(1).max(8).default(2),
  'immune-turns': z.number().min(0).max(8).default(3),
  'session-cap': z.number().min(1).max(256).default(24),
  severities: z.array(SeverityEnum).default(['nit', 'concern', 'blocker']),
  subagents: z.union([z.const('off'), z.const('on'), z.string()]).default('off'),
})

/**
 * Namespace schema. Wrapped in the z.const(undefined) union (turn-rules
 * convention) so a genuinely absent namespace value stays absent instead of
 * materializing defaults into the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>> =
  opt(SettingsObject) as unknown as z<Record<string, unknown>>

/** Ship-dark defaults (§4.8): enabled false. */
export const DEFAULT_ADVISOR_SETTINGS: AdvisorSettings = {
  enabled: false,
  alias: 'haiku',
  budget: 2,
  immuneTurns: 3,
  sessionCap: 24,
  severities: ['nit', 'concern', 'blocker'],
  subagents: 'off',
}

/**
 * Register the settings namespace (for /config UX and validation only —
 * the listener reads the raw user file). Returns the live reader, or
 * `undefined` when the host has no settings provider.
 */
export function registerSettings(ctx: Context): (() => AdvisorSettings) | undefined {
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
      if (value === undefined) return DEFAULT_ADVISOR_SETTINGS
      return resolveSection(value as unknown as Record<string, unknown>)
    } catch {
      // Malformed live scope → ship defaults; never throw into a hot path.
      return DEFAULT_ADVISOR_SETTINGS
    }
  }
}

/** Resolve one raw section into the settings shape with defaults. */
function resolveSection(section: Record<string, unknown>): AdvisorSettings {
  const resolved = SettingsObject(section as unknown as Record<string, never>) as unknown as Record<string, unknown>
  const asInt = (value: unknown, fallback: number): number => {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
    return n
  }
  return {
    enabled: resolved.enabled as boolean,
    alias: resolved.alias as string,
    budget: asInt(resolved.budget, 2),
    immuneTurns: asInt(resolved['immune-turns'], 3),
    sessionCap: asInt(resolved['session-cap'], 24),
    severities: (resolved.severities as Severity[]) ?? DEFAULT_ADVISOR_SETTINGS.severities,
    subagents: (resolved.subagents as 'off' | 'on' | string) ?? 'off',
  }
}

/**
 * Read the settings DIRECTLY from `<dshHome>/settings.json`, bypassing the
 * merged cascade. Fail-soft: absent file, parse error, or a malformed section
 * yields the ship defaults. Project scope is never read — invisible, not refused.
 */
export async function readUserSettings(dshHome: string): Promise<AdvisorSettings> {
  let text: string
  try {
    text = await readFile(join(dshHome, 'settings.json'), 'utf8')
  } catch {
    return DEFAULT_ADVISOR_SETTINGS
  }
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return DEFAULT_ADVISOR_SETTINGS
  }
  if (typeof root !== 'object' || root === null) return DEFAULT_ADVISOR_SETTINGS
  const section = (root as Record<string, unknown>)[SETTINGS_NAMESPACE]
  if (typeof section !== 'object' || section === null) return DEFAULT_ADVISOR_SETTINGS
  try {
    return resolveSection(section as Record<string, unknown>)
  } catch {
    return DEFAULT_ADVISOR_SETTINGS
  }
}

/**
 * SYNCHRONOUS raw read of `<dshHome>/settings.json` — the trigger-side half
 * of the dual-half pattern (§4.9): the `agent/turn-stopping` handler must run
 * synchronously up to capture (a step can begin during the handler's
 * microtasks, and an async read would let the next request's snapshot
 * overwrite the one being reviewed). Same fail-soft semantics as
 * {@link readUserSettings}.
 */
export function readUserSettingsSync(dshHome: string): AdvisorSettings {
  let text: string
  try {
    text = readFileSync(join(dshHome, 'settings.json'), 'utf8')
  } catch {
    return DEFAULT_ADVISOR_SETTINGS
  }
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return DEFAULT_ADVISOR_SETTINGS
  }
  if (typeof root !== 'object' || root === null) return DEFAULT_ADVISOR_SETTINGS
  const section = (root as Record<string, unknown>)[SETTINGS_NAMESPACE]
  if (typeof section !== 'object' || section === null) return DEFAULT_ADVISOR_SETTINGS
  try {
    return resolveSection(section as Record<string, unknown>)
  } catch {
    return DEFAULT_ADVISOR_SETTINGS
  }
}
