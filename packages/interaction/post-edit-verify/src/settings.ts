/**
 * Settings for post-edit auto-verify (design doc §3.4/§3.6), two halves:
 *
 * 1. namespace registration via `@dsh-cc/settings-ns` (schema uses the kebab
 *    keys users author in settings.json, context-crusher convention);
 * 2. a RAW user-layer read of `<dshHome>/settings.json` that bypasses the
 *    merged cascade entirely, so project-scope rules are structurally
 *    invisible — verify rules are a personal productivity setting, not a
 *    project artifact. The file is re-read per use (a few KB), which also
 *    gives free hot reload.
 *
 * The raw reader is local: `readUserFile` is not a package-root export of
 * `@dsh-cc/settings-cascade` (it lives in persist.ts), and it throws on a
 * parse error where this seam must fail soft.
 *
 * @module
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings-ns'
import type { VerifyRule } from './rules.ts'

/** The settings namespace carrying the feature flag and rules. */
export const SETTINGS_NAMESPACE = 'cc-post-edit-verify' as SettingsNamespace

/** Resolved settings shape (camelCase internal; config keys are kebab). */
export interface RulesSettings {
  enabled: boolean
  rules: VerifyRule[]
  debounceMs: number
  maxOutputBytes: number
  verboseOnSuccess: boolean
}

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/** Inner object shape (kebab keys). Absence resolves to defaults via schemastery. */
const SettingsObject = z.object({
  enabled: z.boolean().default(false),
  rules: z.array(z.object({
    glob: z.string(),
    command: z.string(),
    'timeout-ms': opt(z.number()),
  })),
  'debounce-ms': z.number().default(5000),
  'max-output-bytes': z.number().default(4096),
  'verbose-on-success': z.boolean().default(false),
})

/**
 * Namespace schema. Wrapped in the z.const(undefined) union (receipt.ts
 * convention) so a genuinely absent namespace value stays absent instead of
 * materializing defaults into the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>> =
  opt(SettingsObject) as unknown as z<Record<string, unknown>>

/** Ship-dark defaults, used when the user file is absent or malformed. */
export const DEFAULT_RULES_SETTINGS: RulesSettings = {
  enabled: false,
  rules: [],
  debounceMs: 5000,
  maxOutputBytes: 4096,
  verboseOnSuccess: false,
}

/**
 * Strict rule validation. Schemastery `z.object` silently DROPS missing keys
 * (receipt.ts:57 — hence its exact-key-set checks), so a rule missing
 * `command` must be rejected explicitly.
 */
export function rulesOf(rules: unknown): VerifyRule[] {
  if (!Array.isArray(rules)) throw new TypeError('cc-post-edit-verify: rules must be an array')
  return rules.map((rule) => {
    if (typeof rule !== 'object' || rule === null) throw new TypeError('cc-post-edit-verify: each rule must be an object')
    const { glob, command, 'timeout-ms': timeoutMs } = rule as Record<string, unknown>
    if (typeof glob !== 'string' || glob.length === 0) throw new TypeError('cc-post-edit-verify: rule.glob must be a non-empty string')
    if (typeof command !== 'string' || command.length === 0) throw new TypeError('cc-post-edit-verify: rule.command must be a non-empty string')
    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new TypeError('cc-post-edit-verify: rule.timeout-ms must be a positive number')
    }
    return timeoutMs === undefined ? { glob, command } : { glob, command, timeoutMs }
  })
}

/** Map the kebab schema shape onto the camelCase internal shape (strictly validated). */
function resolveRules(section: Record<string, unknown>): RulesSettings {
  const resolved = SettingsObject(section as unknown as Record<string, never>) as unknown as Record<string, unknown>
  return {
    enabled: resolved.enabled as boolean,
    rules: rulesOf(resolved.rules),
    debounceMs: resolved['debounce-ms'] as number,
    maxOutputBytes: resolved['max-output-bytes'] as number,
    verboseOnSuccess: resolved['verbose-on-success'] as boolean,
  }
}

/**
 * Register the settings namespace (for /config UX and validation only —
 * trigger logic reads the raw user file). Returns the live reader, or
 * `undefined` when the host has no settings provider.
 */
export function registerSettings(ctx: Context): (() => RulesSettings) | undefined {
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
      return value === undefined ? DEFAULT_RULES_SETTINGS : resolveRules(value)
    } catch {
      // Malformed live scope → ship-dark defaults; never throw into a hot path.
      return DEFAULT_RULES_SETTINGS
    }
  }
}

/**
 * Read verify rules DIRECTLY from `<dshHome>/settings.json`, bypassing the
 * merged cascade (design doc §3.4). Fail-soft: absent file, parse error, or
 * a malformed section yields the ship-dark defaults. Project-scope rules are
 * never read — they are invisible, not refused.
 */
export async function readUserRules(dshHome: string): Promise<RulesSettings> {
  let text: string
  try {
    text = await readFile(join(dshHome, 'settings.json'), 'utf8')
  } catch {
    return DEFAULT_RULES_SETTINGS
  }
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return DEFAULT_RULES_SETTINGS
  }
  if (typeof root !== 'object' || root === null) return DEFAULT_RULES_SETTINGS
  const section = (root as Record<string, unknown>)['cc-post-edit-verify']
  if (section === undefined) return DEFAULT_RULES_SETTINGS
  try {
    return resolveRules(section as Record<string, unknown>)
  } catch {
    return DEFAULT_RULES_SETTINGS
  }
}
