/**
 * Settings for LSP diagnostics-on-write (design doc §4.6), two halves:
 *
 * 1. namespace registration via `@dsh-cc/settings-ns` (schema uses the kebab
 *    keys users author in settings.json, context-crusher convention);
 * 2. a RAW user-layer read of `<dshHome>/settings.json` that bypasses the
 *    merged cascade entirely, so project scope is structurally invisible —
 *    this is a personal productivity setting. The file is re-read per event,
 *    which also gives free hot reload.
 *
 * The raw reader is local: `readUserFile` is not a package-root export of
 * `@dsh-cc/settings-cascade`, and it throws on a parse error where this seam
 * must fail soft (post-edit-verify settings.ts precedent).
 *
 * @module
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings-ns'

/** The settings namespace carrying the feature flag and knobs. */
export const SETTINGS_NAMESPACE = 'cc-lsp-on-write' as SettingsNamespace

/** Severity floor for rendered diagnostics. */
export type MinSeverity = 'error' | 'warning'

/** Resolved settings shape (camelCase internal; config keys are kebab). */
export interface LspOnWriteSettings {
  enabled: boolean
  serverName: string
  timeoutMs: number
  maxDiagnostics: number
  minSeverity: MinSeverity
  /** When set, replaces the built-in matcher set wholesale (doc §4.1). */
  toolNames: string[] | undefined
}

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/** Inner object shape (kebab keys). Absence resolves to defaults via schemastery. */
const SettingsObject = z.object({
  enabled: z.boolean().default(false),
  'server-name': z.string().default('serena'),
  'timeout-ms': z.number().default(1500),
  'max-diagnostics': z.number().default(8),
  'min-severity': z.string().default('warning'),
  'tool-names': opt(z.array(z.string())),
})

/**
 * Namespace schema. Wrapped in the z.const(undefined) union (post-edit-verify
 * convention) so a genuinely absent namespace value stays absent instead of
 * materializing defaults into the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>> =
  opt(SettingsObject) as unknown as z<Record<string, unknown>>

/** Ship-dark defaults, used when the user file is absent or malformed. */
export const DEFAULT_LSP_SETTINGS: LspOnWriteSettings = {
  enabled: false,
  serverName: 'serena',
  timeoutMs: 1500,
  maxDiagnostics: 8,
  minSeverity: 'warning',
  toolNames: undefined,
}

/** Map the kebab schema shape onto the camelCase internal shape (validated). */
function resolveSection(section: Record<string, unknown>): LspOnWriteSettings {
  const resolved = SettingsObject(section as unknown as Record<string, never>) as unknown as Record<string, unknown>
  return {
    enabled: resolved.enabled as boolean,
    serverName: resolved['server-name'] as string,
    timeoutMs: resolved['timeout-ms'] as number,
    maxDiagnostics: resolved['max-diagnostics'] as number,
    minSeverity: resolved['min-severity'] === 'error' ? 'error' : 'warning',
    toolNames: resolved['tool-names'] as string[] | undefined,
  }
}

/**
 * Register the settings namespace (for /config UX and validation only —
 * trigger logic reads the raw user file per event).
 */
export function registerSettings(ctx: Context): void {
  registerNamespaceSafe<Record<string, unknown>>(
    ctx,
    SETTINGS_NAMESPACE,
    SettingsSchema as unknown as z<Record<string, unknown>>,
  )
}

/**
 * Read settings DIRECTLY from `<dshHome>/settings.json`, bypassing the merged
 * cascade (design doc §4.6). Fail-soft: absent file, parse error, or a
 * malformed section yields the ship-dark defaults. Project scope is never
 * read — invisible, not refused.
 */
export async function readUserSettings(dshHome: string): Promise<LspOnWriteSettings> {
  let text: string
  try {
    text = await readFile(join(dshHome, 'settings.json'), 'utf8')
  } catch {
    return DEFAULT_LSP_SETTINGS
  }
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return DEFAULT_LSP_SETTINGS
  }
  if (typeof root !== 'object' || root === null) return DEFAULT_LSP_SETTINGS
  const section = (root as Record<string, unknown>)[SETTINGS_NAMESPACE]
  if (typeof section !== 'object' || section === null) return DEFAULT_LSP_SETTINGS
  try {
    return resolveSection(section as Record<string, unknown>)
  } catch {
    return DEFAULT_LSP_SETTINGS
  }
}
