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

import z from '@deepseek-ai/schemastery'

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
