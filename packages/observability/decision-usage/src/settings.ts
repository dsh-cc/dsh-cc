/**
 * Settings schema for namespace `systemone-decisions` (design
 * docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md
 * §"Settings and capability declaration").
 *
 * Schema-first (vwa-evidence idiom: `registerNamespaceSafe` + absence-
 * preserving union), kebab keys, defaults per the design table. The cascade
 * reassembles this namespace from trusted sources only (user/managed/
 * explicit --settings — `TRUSTED_SOURCE_KEYS` in @dsh-cc/settings/cascade),
 * so this module performs NO source filtering of its own; it validates shape.
 *
 * `routes` holds the per-alias pin rows of the single decision lane: the
 * retired `capabilities` table duplicated the gauge alias's route config, so
 * the alias (via @dsh-cc/model-aliases) is now the only route source and a
 * row can only NARROW its own alias (revision, optional version pin, token
 * bounds). Route ROW content is deliberately not judged here — a broken row
 * must invalidate its alias alone, at resolution time (see route.ts).
 *
 * @module @dsh-cc/decision-usage/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings'
import z from '@deepseek-ai/schemastery'
import { copyForMutation, registerNamespaceSafe } from '@dsh-cc/settings/ns'

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
 * One raw `routes` pin row (kebab-case). EVERY key is optional: an absent key
 * means "use the default" (registry-derived input bounds, 32768 output,
 * 32 questions, revision = the resolved wire model id, no version pin).
 * Presence is judged per key at resolution time (route.ts), where a present
 * but invalid value makes that alias alone unusable.
 */
export interface DecisionRoutePinRowSettings {
  revision?: string
  'actual-model-id'?: string
  'per-request-tokens'?: number
  'per-question-tokens'?: number
  'max-output-tokens'?: number
  'max-questions'?: number
}

/** Resolved settings shape (raw kebab keys, verbatim from the cascade). */
export interface SystemOneDecisionsSettings {
  'max-attempts-per-session': number
  'max-input-tokens-per-session': number
  'max-output-tokens-per-session': number
  'max-retries': number
  routes: Record<string, DecisionRoutePinRowSettings>
  'ledger-max-bytes': number
}

/** Ship defaults (design table): no pin rows — every alias runs on defaults. */
export const DEFAULT_DECISION_SETTINGS: SystemOneDecisionsSettings = {
  'max-attempts-per-session': DEFAULT_MAX_ATTEMPTS_PER_SESSION,
  'max-input-tokens-per-session': DEFAULT_MAX_INPUT_TOKENS_PER_SESSION,
  'max-output-tokens-per-session': DEFAULT_MAX_OUTPUT_TOKENS_PER_SESSION,
  'max-retries': DEFAULT_MAX_RETRIES,
  routes: {},
  'ledger-max-bytes': DEFAULT_LEDGER_MAX_BYTES,
}

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/**
 * One pin-row field: the declared constraint documents the intended shape (and
 * reaches the settings UI), but no value is rejected here. schemastery fails
 * the WHOLE object on one bad field, which would let a single broken alias
 * disable its siblings — so invalid row content is tolerated at parse and
 * judged per alias in {@link resolveDecisionRoute}.
 */
const pinField = <T>(t: z<T>): z<T | undefined> => z.union([t, z.any()]) as z<T | undefined>

/** One per-alias pin row: every field optional, defaults applied at resolution. */
const RouteRowObject = z.object({
  revision: pinField(z.string().min(1)),
  'actual-model-id': pinField(z.string().min(1).max(MAX_ACTUAL_MODEL_ID_CHARS)),
  'per-request-tokens': pinField(z.number().min(1)),
  'per-question-tokens': pinField(z.number().min(1)),
  'max-output-tokens': pinField(z.number().min(1)),
  'max-questions': pinField(z.number().min(1)),
})

/**
 * Inner object shape (kebab keys). Absence resolves to defaults via
 * schemastery. Dict keys are matched case-insensitively at resolution time
 * (`routes.Gauge` applies to `gauge`), so they are not normalized here.
 */
const SettingsObject = z.object({
  'max-attempts-per-session': z.number().min(0).default(DEFAULT_MAX_ATTEMPTS_PER_SESSION),
  'max-input-tokens-per-session': z.number().min(0).default(DEFAULT_MAX_INPUT_TOKENS_PER_SESSION),
  'max-output-tokens-per-session': z.number().min(0).default(DEFAULT_MAX_OUTPUT_TOKENS_PER_SESSION),
  'max-retries': z.number().min(0).max(MAX_RETRIES_LIMIT).default(DEFAULT_MAX_RETRIES),
  routes: z.dict(pinField(RouteRowObject) as unknown as z<unknown>).default({}),
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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

/** The quota keys whose values must be present-and-numeric safe integers. */
const QUOTA_KEYS = [
  'max-attempts-per-session',
  'max-input-tokens-per-session',
  'max-output-tokens-per-session',
  'max-retries',
  'ledger-max-bytes',
] as const

/**
 * Tri-state parse result. `absent` (no namespace at all) keeps the alias
 * derived routes usable on ship defaults; `invalid` fails the WHOLE section
 * closed — no route is usable, so nothing can dispatch (quota admission may
 * still compute ship defaults, but nothing is dispatched without a route).
 */
/** Stable machine reasons for an invalid section (fixed enums — never raw
 *  exception text or input values, so a warn line is greppable and safe). */
export type DecisionInvalidReason =
  | 'not-an-object'
  | 'quota-key-type'
  | 'quota-bounds'
  | 'legacy-capabilities'
  | 'routes-shape'
  | 'schema'
  | 'schema-throw'

export type DecisionSettingsParseResult =
  | { status: 'absent' }
  | { status: 'valid'; settings: SystemOneDecisionsSettings }
  | { status: 'invalid'; reason: DecisionInvalidReason }

/**
 * Strictly parse one merged `systemone-decisions` section into the tri-state
 * result. Schema validation plus the checks schemastery cannot express: every
 * quota bound a safe integer (attempt/token limits non-negative, ledger-bytes
 * at least the design minimum), `routes` a plain object, and no leftover
 * `capabilities` rows.
 *
 * A leftover `capabilities` table fails the section closed: the field was
 * retired, and honouring configs written against it would silently unpin
 * routes. An empty `capabilities: []` is tolerated as a stale-but-inert
 * leftover. Any violation invalidates the WHOLE section — an invalid
 * configuration is never partially applied, so a typo cannot silently widen
 * or narrow the deployment's budget contract.
 */
export function parseDecisionSettings(raw: unknown): DecisionSettingsParseResult {
  if (raw === undefined) return { status: 'absent' }
  if (!isPlainObject(raw)) return { status: 'invalid', reason: 'not-an-object' }
  // A quota key spelled with a non-number (a JSON `null` included — schemastery
  // would silently restore the default) is an operator typo, never a reset.
  for (const key of QUOTA_KEYS) {
    if (hasOwn(raw, key) && typeof raw[key] !== 'number') return { status: 'invalid', reason: 'quota-key-type' }
  }
  if (hasOwn(raw, 'capabilities')) {
    const legacy = raw.capabilities
    if (!Array.isArray(legacy) || legacy.length > 0) return { status: 'invalid', reason: 'legacy-capabilities' }
  }
  if (hasOwn(raw, 'routes') && !isPlainObject(raw.routes)) return { status: 'invalid', reason: 'routes-shape' }
  let resolved: Record<string, unknown>
  try {
    // Issue #373: the cascade read-through serves deep-frozen sections and
    // schemastery's dict resolution reassigns entries in place — re-admit a
    // mutable copy so a frozen `routes` dict can never throw the parse into
    // `invalid`. The copy is structure-preserving: admission is unchanged.
    resolved = SettingsObject(copyForMutation(raw) as Record<string, never>) as unknown as Record<string, unknown>
  } catch {
    return { status: 'invalid', reason: 'schema' }
  }
  const attempts = resolved['max-attempts-per-session']
  const input = resolved['max-input-tokens-per-session']
  const output = resolved['max-output-tokens-per-session']
  const retries = resolved['max-retries']
  const ledgerBytes = resolved['ledger-max-bytes']
  if (!isSafeNatural(attempts) || !isSafeNatural(input) || !isSafeNatural(output)) return { status: 'invalid', reason: 'quota-bounds' }
  if (!isSafeNatural(retries) || retries > MAX_RETRIES_LIMIT) return { status: 'invalid', reason: 'quota-bounds' }
  if (!isSafeNatural(ledgerBytes) || ledgerBytes < MIN_LEDGER_MAX_BYTES) return { status: 'invalid', reason: 'quota-bounds' }
  if (!isPlainObject(resolved.routes)) return { status: 'invalid', reason: 'routes-shape' }
  return { status: 'valid', settings: resolved as unknown as SystemOneDecisionsSettings }
}

/** Adapt the tri-state result to the valid-or-absent settings shape. */
export function decisionSettingsOf(result: DecisionSettingsParseResult): SystemOneDecisionsSettings | undefined {
  return result.status === 'valid' ? result.settings : undefined
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
 * yield the design-table defaults — an invalid section independently keeps
 * every route unusable (fail closed), so defaults here can never admit a
 * decision that trusted settings did not explicitly enable.
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
