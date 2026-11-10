/**
 * Settings namespace `cc-systemone-memory-recall` (design
 * docs/plans/2026-11-02-systemone-03-memory-recall.md §"Configuration has its
 * own namespace").
 *
 * Schema-first (the vwa-evidence / decision-usage idiom): `registerNamespaceSafe`
 * plus an absence-preserving `z.const(undefined)` union so a genuinely absent
 * namespace stays absent instead of materializing defaults into the cascade.
 * External keys are kebab-case, the internal {@link RecallDecisionSettings}
 * shape is camelCase. The namespace is separate from the legacy
 * `memory.recallEnabled` master switch, which keeps governing all three modes.
 *
 * Validation policy (design, doc-verbatim): a section with ANY invalid field is
 * rejected whole — the provider keeps its previous valid snapshot, and a
 * rejected first registration degrades to the defaults. Out-of-range values are
 * NEVER clamped into range.
 *
 * @module @dsh-cc/memory/recall-decision-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings-provider'
import z from '@deepseek-ai/schemastery'
import { copyForMutation, registerNamespaceSafe } from '@dsh-cc/settings-ns'

/** The settings namespace carrying the memory-recall decision contract. */
export const SETTINGS_NAMESPACE = 'cc-systemone-memory-recall'

/** The three dispatch modes; `off` sends no decision request at all. */
export type RecallDecisionMode = 'off' | 'shadow' | 'active'

/** Design-table defaults (camelCase, internal shape). */
export const DEFAULT_RECALL_DECISION_SETTINGS = {
  mode: 'off' as RecallDecisionMode,
  timeoutMs: 1500,
  maxInputTokens: 6000,
  maxCandidates: 96,
  batchSize: 24,
  includeProbability: 0.75,
  excludeProbability: 0.25,
  fallbackMaxCandidates: 256,
  fallbackMaxBytes: 65536,
} as const

/** Internal camelCase settings shape consumed by the recall slices. */
export interface RecallDecisionSettings {
  mode: RecallDecisionMode
  timeoutMs: number
  maxInputTokens: number
  maxCandidates: number
  batchSize: number
  includeProbability: number
  excludeProbability: number
  fallbackMaxCandidates: number
  fallbackMaxBytes: number
}

/** One resolved settings section (raw kebab-case keys, schema-resolved). */
export interface RecallDecisionSection {
  mode: RecallDecisionMode
  'timeout-ms': number
  'max-input-tokens': number
  'max-candidates': number
  'batch-size': number
  'include-probability': number
  'exclude-probability': number
  'fallback-max-candidates': number
  'fallback-max-bytes': number
}

/** Design-table defaults (kebab-case, external shape). */
export const DEFAULT_RECALL_DECISION_SECTION: RecallDecisionSection = {
  mode: DEFAULT_RECALL_DECISION_SETTINGS.mode,
  'timeout-ms': DEFAULT_RECALL_DECISION_SETTINGS.timeoutMs,
  'max-input-tokens': DEFAULT_RECALL_DECISION_SETTINGS.maxInputTokens,
  'max-candidates': DEFAULT_RECALL_DECISION_SETTINGS.maxCandidates,
  'batch-size': DEFAULT_RECALL_DECISION_SETTINGS.batchSize,
  'include-probability': DEFAULT_RECALL_DECISION_SETTINGS.includeProbability,
  'exclude-probability': DEFAULT_RECALL_DECISION_SETTINGS.excludeProbability,
  'fallback-max-candidates': DEFAULT_RECALL_DECISION_SETTINGS.fallbackMaxCandidates,
  'fallback-max-bytes': DEFAULT_RECALL_DECISION_SETTINGS.fallbackMaxBytes,
}

/** Hard bounds of the design table. */
export const MIN_TIMEOUT_MS = 100
/**
 * Opt-in ceiling for the whole-round deadline (issue #373: the old 5000 sat
 * BELOW the default planner's realistic need — one 24-candidate batch measured
 * ~1.3 s and the default 96/24 planning runs four batches ≈ 5.2 s). The DEFAULT
 * stays 1500; the ceiling exists so operators can size the round to their pool.
 */
export const MAX_TIMEOUT_MS = 30000
export const MIN_MAX_INPUT_TOKENS = 512
export const MAX_MAX_INPUT_TOKENS = 16000
export const MIN_MAX_CANDIDATES = 1
export const MAX_MAX_CANDIDATES = 256
export const MIN_BATCH_SIZE = 1
export const MAX_BATCH_SIZE = 32
export const MIN_INCLUDE_PROBABILITY = 0.5
export const MAX_INCLUDE_PROBABILITY = 1
export const MIN_EXCLUDE_PROBABILITY = 0
export const MAX_EXCLUDE_PROBABILITY = 0.5
export const MAX_FALLBACK_MAX_CANDIDATES = 1024
export const MIN_FALLBACK_MAX_BYTES = 4096
export const MAX_FALLBACK_MAX_BYTES = 262144

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/**
 * Inner object shape (kebab keys). Absence of a field resolves to its design
 * default via schemastery; ranges and integrality are enforced here, cross-field
 * rules by {@link validateRecallDecisionSettings}. `.step(1)` is schemastery's
 * integer check (it also rejects `NaN`), never a rounding pass.
 */
const SettingsObject = z.object({
  mode: z.union([z.const('off'), z.const('shadow'), z.const('active')]).default(DEFAULT_RECALL_DECISION_SETTINGS.mode),
  'timeout-ms': z.number().step(1).min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS)
    .default(DEFAULT_RECALL_DECISION_SETTINGS.timeoutMs),
  'max-input-tokens': z.number().step(1).min(MIN_MAX_INPUT_TOKENS).max(MAX_MAX_INPUT_TOKENS)
    .default(DEFAULT_RECALL_DECISION_SETTINGS.maxInputTokens),
  'max-candidates': z.number().step(1).min(MIN_MAX_CANDIDATES).max(MAX_MAX_CANDIDATES)
    .default(DEFAULT_RECALL_DECISION_SETTINGS.maxCandidates),
  'batch-size': z.number().step(1).min(MIN_BATCH_SIZE).max(MAX_BATCH_SIZE)
    .default(DEFAULT_RECALL_DECISION_SETTINGS.batchSize),
  'include-probability': z.number().min(MIN_INCLUDE_PROBABILITY).max(MAX_INCLUDE_PROBABILITY)
    .default(DEFAULT_RECALL_DECISION_SETTINGS.includeProbability),
  'exclude-probability': z.number().min(MIN_EXCLUDE_PROBABILITY).max(MAX_EXCLUDE_PROBABILITY)
    .default(DEFAULT_RECALL_DECISION_SETTINGS.excludeProbability),
  'fallback-max-candidates': z.number().step(1).min(MIN_MAX_CANDIDATES).max(MAX_FALLBACK_MAX_CANDIDATES)
    .default(DEFAULT_RECALL_DECISION_SETTINGS.fallbackMaxCandidates),
  'fallback-max-bytes': z.number().step(1).min(MIN_FALLBACK_MAX_BYTES).max(MAX_FALLBACK_MAX_BYTES)
    .default(DEFAULT_RECALL_DECISION_SETTINGS.fallbackMaxBytes),
})

/**
 * Namespace schema, wrapped in the `z.const(undefined)` union so an absent
 * namespace resolves to `undefined` (callers then keep the defaults) instead of
 * materializing a section into the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>> =
  opt(SettingsObject) as unknown as z<Record<string, unknown>>

/** Whether `value` is a finite number (schemastery accepts `NaN` as a number). */
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * The namespace's own validation: shape, ranges and integrality (re-admitted
 * through {@link SettingsObject}) plus the checks the schema cannot express —
 * every probability is finite, the exclusion threshold sits strictly below the
 * inclusion threshold, and the legacy fallback pool is never smaller than the
 * SystemOne pool.
 *
 * Throws (never repairs, never clamps): the provider turns a throw into a
 * rejected update that keeps the previous valid snapshot, and a throw on the
 * first registration degrades the reader to the defaults. The provider has
 * normally admitted the value through the schema already, so the re-admission is
 * idempotent; it keeps this exported check total for direct callers.
 * @param value - the section to check.
 */
export function validateRecallDecisionSettings(value: RecallDecisionSection): void {
  // Issue #373 (latent here: the provider invokes validate pre-freeze): a
  // cascade section may arrive deep-frozen, and schemastery re-admission
  // mutates in place — re-admit a structure-preserving copy, then read every
  // cross-field check from the RESOLVED copy so schema-filled defaults are the
  // source of truth instead of the raw object's pre-schema holes.
  const resolved = SettingsObject(copyForMutation(value) as never) as unknown as RecallDecisionSection
  const include = resolved['include-probability']
  const exclude = resolved['exclude-probability']
  if (!isFiniteNumber(include) || !isFiniteNumber(exclude)) {
    throw new TypeError(`${SETTINGS_NAMESPACE}: probabilities must be finite numbers`)
  }
  // A grey zone needs an open interval; exclude >= include would invert it.
  if (exclude >= include) {
    throw new TypeError(`${SETTINGS_NAMESPACE}: exclude-probability must be less than include-probability`)
  }
  if (resolved['fallback-max-candidates'] < resolved['max-candidates']) {
    throw new TypeError(`${SETTINGS_NAMESPACE}: fallback-max-candidates must not be below max-candidates`)
  }
}

/**
 * Map a resolved section onto the internal camelCase shape. An absent namespace
 * (no settings service, nothing registered, or an invalid first registration)
 * yields the design-table defaults.
 * @param section - the resolved kebab-case section, or `undefined`.
 * @returns the internal settings.
 */
export function recallDecisionSettings(section: RecallDecisionSection | undefined): RecallDecisionSettings {
  const s = section ?? DEFAULT_RECALL_DECISION_SECTION
  return {
    mode: s.mode ?? DEFAULT_RECALL_DECISION_SETTINGS.mode,
    timeoutMs: s['timeout-ms'] ?? DEFAULT_RECALL_DECISION_SETTINGS.timeoutMs,
    maxInputTokens: s['max-input-tokens'] ?? DEFAULT_RECALL_DECISION_SETTINGS.maxInputTokens,
    maxCandidates: s['max-candidates'] ?? DEFAULT_RECALL_DECISION_SETTINGS.maxCandidates,
    batchSize: s['batch-size'] ?? DEFAULT_RECALL_DECISION_SETTINGS.batchSize,
    includeProbability: s['include-probability'] ?? DEFAULT_RECALL_DECISION_SETTINGS.includeProbability,
    excludeProbability: s['exclude-probability'] ?? DEFAULT_RECALL_DECISION_SETTINGS.excludeProbability,
    fallbackMaxCandidates: s['fallback-max-candidates'] ?? DEFAULT_RECALL_DECISION_SETTINGS.fallbackMaxCandidates,
    fallbackMaxBytes: s['fallback-max-bytes'] ?? DEFAULT_RECALL_DECISION_SETTINGS.fallbackMaxBytes,
  }
}

/**
 * Register the namespace and return the live camelCase reader.
 *
 * - No settings service: defaults (the registration is deferred by the helper
 *   and this reader keeps serving the defaults until it lands).
 * - A rejected first registration (`validate` throws): defaults — never a half
 *   applied snapshot.
 * - A rejected update keeps the provider's previous valid snapshot; this reader
 *   is a read-through, so it observes that snapshot on the next call.
 * @param ctx - the owning plugin context.
 * @returns a reader resolving the current internal settings.
 */
export function registerRecallDecisionSettings(ctx: Context): () => RecallDecisionSettings {
  try {
    const read = registerNamespaceSafe<RecallDecisionSection>(
      ctx,
      SETTINGS_NAMESPACE as SettingsNamespace,
      SettingsSchema as unknown as z<RecallDecisionSection>,
      { validate: validateRecallDecisionSettings },
    )
    return () => recallDecisionSettings(read())
  } catch {
    // An absent/broken settings layer must never break mounting: serve defaults.
    return () => recallDecisionSettings(undefined)
  }
}
