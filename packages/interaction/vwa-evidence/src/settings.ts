/**
 * Settings schema for namespace `vwa-evidence` (design
 * docs/plans/2026-10-12-verifiable-workspace-agent.md §4.4).
 *
 * Schema-first (skill-usage shape: `registerNamespaceSafe` + absence-
 * preserving union), kebab keys. Registration happens in P2b's plugin
 * apply — this module exports the schema and the ship defaults; both are
 * covered by shape tests. Default ON, mounted only in preset vwa.
 *
 * @module @dsh-cc/vwa-evidence/settings
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings-provider'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings-ns'

/** The settings namespace carrying the VWA evidence flags (§4.4). */
export const SETTINGS_NAMESPACE = 'vwa-evidence'

/** Resolved settings shape. */
export interface VwaEvidenceSettings {
  enabled: boolean
  'nudge-budget': number
  'gate-timeout-ms': number
  'coverage-threshold': number
}

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/** Inner object shape (kebab keys). Absence resolves to defaults via schemastery. */
const SettingsObject = z.object({
  enabled: z.boolean().default(true),
  'nudge-budget': z.number().min(0).max(64).default(4),
  'gate-timeout-ms': z.number().min(1000).max(600_000).default(30_000),
  'coverage-threshold': z.number().min(0).max(1).default(0.9),
})

/**
 * Namespace schema, wrapped in the z.const(undefined) union (turn-rules
 * convention) so a genuinely absent namespace value stays absent instead of
 * materializing defaults into the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>> =
  opt(SettingsObject) as unknown as z<Record<string, unknown>>

/** Ship defaults (§4.4): ON, budget 4, gate timeout 30s, coverage >= 0.9 (§8). */
export const DEFAULT_VWA_EVIDENCE_SETTINGS: VwaEvidenceSettings = {
  enabled: true,
  'nudge-budget': 4,
  'gate-timeout-ms': 30_000,
  'coverage-threshold': 0.9,
}

/**
 * Register the settings namespace (§4.4, skill-usage shape). PLANE NOTE: the
 * registration is /config UX and validation only — the evaluator NEVER reads
 * through the cascade; it re-reads the raw `<dshHome>/settings.json` per
 * event (see {@link readUserSettingsSync}), so a settings edit takes effect
 * on the next turn-stopping dispatch without a restart (completion-gate's
 * dual-half pattern, evaluate-time hot read, §4.4).
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

/** Parse one raw `<dshHome>/settings.json` section into the settings shape. */
function resolveSection(section: Record<string, unknown>): VwaEvidenceSettings {
  const resolved = SettingsObject(section as unknown as Record<string, never>) as unknown as Record<string, unknown>
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return {
    enabled: resolved.enabled === true,
    'nudge-budget': Math.trunc(num(resolved['nudge-budget'], DEFAULT_VWA_EVIDENCE_SETTINGS['nudge-budget'])),
    'gate-timeout-ms': num(resolved['gate-timeout-ms'], DEFAULT_VWA_EVIDENCE_SETTINGS['gate-timeout-ms']),
    'coverage-threshold': num(resolved['coverage-threshold'], DEFAULT_VWA_EVIDENCE_SETTINGS['coverage-threshold']),
  }
}

/**
 * SYNCHRONOUS raw read of `<dshHome>/settings.json` — the hot-path half of
 * the dual-half pattern (§4.4): the turn-stopping handler re-reads per event
 * so settings hot-toggle takes effect on the next turn. Fail-soft: absent
 * file, parse error, or malformed section yields the ship defaults (ON).
 */
export function readUserSettingsSync(dshHome: string): VwaEvidenceSettings {
  let text: string
  try {
    text = readFileSync(join(dshHome, 'settings.json'), 'utf8')
  } catch {
    return DEFAULT_VWA_EVIDENCE_SETTINGS
  }
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return DEFAULT_VWA_EVIDENCE_SETTINGS
  }
  if (typeof root !== 'object' || root === null) return DEFAULT_VWA_EVIDENCE_SETTINGS
  const section = (root as Record<string, unknown>)[SETTINGS_NAMESPACE]
  if (typeof section !== 'object' || section === null) return DEFAULT_VWA_EVIDENCE_SETTINGS
  try {
    return resolveSection(section as Record<string, unknown>)
  } catch {
    return DEFAULT_VWA_EVIDENCE_SETTINGS
  }
}
