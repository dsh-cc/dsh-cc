/**
 * Settings schema for namespace `systemone-decisions` (design
 * docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md
 * §"Settings and capability declaration").
 *
 * Schema-first (vwa-evidence idiom: `registerNamespaceSafe` + absence-
 * preserving union), kebab keys, defaults per the design table. The cascade
 * reassembles this namespace from trusted sources only (user/managed/
 * explicit --settings — `TRUSTED_SOURCE_KEYS` in @dsh-cc/settings-cascade),
 * so this module performs NO source filtering of its own; it validates shape.
 *
 * @module @dsh-cc/decision-usage/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings-provider'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings-ns'

/** The settings namespace carrying the SystemOne decision budget contract. */
export const SETTINGS_NAMESPACE = 'systemone-decisions'

export const DEFAULT_MAX_ATTEMPTS_PER_SESSION = 100
export const DEFAULT_MAX_INPUT_TOKENS_PER_SESSION = 1_000_000
export const DEFAULT_MAX_OUTPUT_TOKENS_PER_SESSION = 100_000
export const DEFAULT_MAX_RETRIES = 0
export const DEFAULT_LEDGER_MAX_BYTES = 10_485_760

/** Hard bounds from the design table. */
export const MAX_RETRIES_LIMIT = 2
export const MIN_LEDGER_MAX_BYTES = 1_048_576
export const MAX_ACTUAL_MODEL_ID_CHARS = 256

/**
 * One raw `capabilities` row (kebab-case, all fields required). Shape-level
 * contract only — safe-integer and duplicate-row semantics are enforced by
 * {@link parseDecisionSettings}, which fails the whole section closed.
 */
export interface DecisionCapabilityRowSettings {
  provider: string
  model: string
  revision: string
  'actual-model-id': string
  'per-request-tokens': number
  'per-question-tokens': number
  'max-output-tokens': number
  'max-questions': number
}

/** Resolved settings shape (raw kebab keys, verbatim from the cascade). */
export interface SystemOneDecisionsSettings {
  'max-attempts-per-session': number
  'max-input-tokens-per-session': number
  'max-output-tokens-per-session': number
  'max-retries': number
  capabilities: DecisionCapabilityRowSettings[]
  'ledger-max-bytes': number
}

/** Ship defaults (design table): capabilities empty — no route is usable off. */
export const DEFAULT_DECISION_SETTINGS: SystemOneDecisionsSettings = {
  'max-attempts-per-session': DEFAULT_MAX_ATTEMPTS_PER_SESSION,
  'max-input-tokens-per-session': DEFAULT_MAX_INPUT_TOKENS_PER_SESSION,
  'max-output-tokens-per-session': DEFAULT_MAX_OUTPUT_TOKENS_PER_SESSION,
  'max-retries': DEFAULT_MAX_RETRIES,
  capabilities: [],
  'ledger-max-bytes': DEFAULT_LEDGER_MAX_BYTES,
}

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/** One capability row: non-empty ids, positive bounds (integer checks live in parse). */
const CapabilityRowObject = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  revision: z.string().min(1),
  'actual-model-id': z.string().min(1).max(MAX_ACTUAL_MODEL_ID_CHARS),
  'per-request-tokens': z.number().min(1),
  'per-question-tokens': z.number().min(1),
  'max-output-tokens': z.number().min(1),
  'max-questions': z.number().min(1),
})

/** Inner object shape (kebab keys). Absence resolves to defaults via schemastery. */
const SettingsObject = z.object({
  'max-attempts-per-session': z.number().min(0).default(DEFAULT_MAX_ATTEMPTS_PER_SESSION),
  'max-input-tokens-per-session': z.number().min(0).default(DEFAULT_MAX_INPUT_TOKENS_PER_SESSION),
  'max-output-tokens-per-session': z.number().min(0).default(DEFAULT_MAX_OUTPUT_TOKENS_PER_SESSION),
  'max-retries': z.number().min(0).max(MAX_RETRIES_LIMIT).default(DEFAULT_MAX_RETRIES),
  capabilities: z.array(CapabilityRowObject).default([]),
  'ledger-max-bytes': z.number().min(MIN_LEDGER_MAX_BYTES).default(DEFAULT_LEDGER_MAX_BYTES),
})

/**
 * Namespace schema, wrapped in the z.const(undefined) union (vwa-evidence
 * convention) so a genuinely absent namespace stays absent instead of
 * materializing defaults into the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>> =
  opt(SettingsObject) as unknown as z<Record<string, unknown>>

export type DecisionSettingsReader = () => Record<string, unknown> | undefined

/**
 * Register the settings namespace and return the live merged reader
 * (registerNamespaceSafe shape: deferred when the settings service has not
 * arrived, never throws across an absent one). The returned section is the
 * cascade-reassembled trusted value — project/local layers never contribute.
 */
export function registerSettings(ctx: Context): DecisionSettingsReader {
  try {
    return registerNamespaceSafe<Record<string, unknown>>(
      ctx,
      SETTINGS_NAMESPACE as SettingsNamespace,
      SettingsSchema as unknown as z<Record<string, unknown>>,
    )
  } catch {
    // An absent/broken settings layer must never break mounting: absent reads.
    return () => undefined
  }
}

const isSafeNatural = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isSafePositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

/**
 * Strictly parse one merged `systemone-decisions` section. Schema validation
 * plus the checks schemastery cannot express: every bound a safe integer
 * (attempt/token limits non-negative; capability bounds positive). Any
 * violation invalidates the WHOLE section (undefined) — an invalid
 * configuration is never partially applied, so a typo cannot silently widen
 * or narrow the deployment's budget contract.
 */
export function parseDecisionSettings(raw: unknown): SystemOneDecisionsSettings | undefined {
  if (raw === undefined) return undefined
  let resolved: Record<string, unknown>
  try {
    resolved = SettingsObject(raw as Record<string, never>) as unknown as Record<string, unknown>
  } catch {
    return undefined
  }
  const attempts = resolved['max-attempts-per-session']
  const input = resolved['max-input-tokens-per-session']
  const output = resolved['max-output-tokens-per-session']
  const retries = resolved['max-retries']
  const ledgerBytes = resolved['ledger-max-bytes']
  if (!isSafeNatural(attempts) || !isSafeNatural(input) || !isSafeNatural(output)) return undefined
  if (!isSafeNatural(retries) || retries > MAX_RETRIES_LIMIT) return undefined
  if (!isSafeNatural(ledgerBytes) || ledgerBytes < MIN_LEDGER_MAX_BYTES) return undefined
  const rows = resolved.capabilities
  if (!Array.isArray(rows)) return undefined
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) return undefined
    const r = row as Record<string, unknown>
    if (!isSafePositive(r['per-request-tokens'])) return undefined
    if (!isSafePositive(r['per-question-tokens'])) return undefined
    if (!isSafePositive(r['max-output-tokens'])) return undefined
    if (!isSafePositive(r['max-questions'])) return undefined
  }
  return resolved as unknown as SystemOneDecisionsSettings
}

/** Session quota limits, adapted camelCase for the quota module. */
export interface DecisionSessionLimits {
  maxAttempts: number
  maxInputTokens: number
  maxOutputTokens: number
  ledgerMaxBytes: number
}

/**
 * Adapt parsed settings into session quota limits. Absent or invalid settings
 * yield the design-table defaults — capability absence independently keeps
 * every route unconfigured, so defaults here can never admit a decision that
 * trusted settings did not explicitly enable.
 */
export function decisionSessionLimits(settings: SystemOneDecisionsSettings | undefined): DecisionSessionLimits {
  const s = settings ?? DEFAULT_DECISION_SETTINGS
  return {
    maxAttempts: s['max-attempts-per-session'],
    maxInputTokens: s['max-input-tokens-per-session'],
    maxOutputTokens: s['max-output-tokens-per-session'],
    ledgerMaxBytes: s['ledger-max-bytes'],
  }
}

/** Clamp a parsed max-retries into the client's 0..2 contract. */
export function decisionMaxRetries(settings: SystemOneDecisionsSettings | undefined): number {
  return settings?.['max-retries'] ?? DEFAULT_MAX_RETRIES
}
