/**
 * Settings schema for namespace `cc-systemone-memory-extraction` (design
 * docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md §"Settings,
 * defaults and ranges").
 *
 * Schema-first (decision-usage idiom: `registerNamespaceSafe` + an
 * absence-preserving union), kebab-case external keys, defaults per the design
 * table. The section is read as a DYNAMIC snapshot: every read re-resolves the
 * live cascade value, so a mode flip is observed by the next gate entry
 * without a restart.
 *
 * Whole-section rejection: any out-of-range or mistyped field invalidates the
 * WHOLE section and the previous accepted snapshot stays in force, so a typo
 * can never partially widen a bound. An absent namespace (never configured, or
 * its owner fiber went away) reads the ship defaults — `mode: off`, which
 * answers without ever reading a decision runner.
 *
 * @module @dsh-cc/memory-consolidation/extraction-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { copyForMutation, registerNamespaceSafe } from '@dsh-cc/settings/ns'

/**
 * Branded namespace id, derived from the registrar's own signature so this
 * module needs no direct settings-provider type import.
 */
type RegisteredNamespace = Parameters<typeof registerNamespaceSafe>[1]

/** The settings namespace carrying the extraction-decision gate contract. */
export const SETTINGS_NAMESPACE = 'cc-systemone-memory-extraction' as RegisteredNamespace

/** Gate modes: `off` never reads the runner, `shadow` only records, `active` may skip. */
export type ExtractionMode = 'off' | 'shadow' | 'active'

/**
 * Effective gate settings (internal camelCase shape). Startup defaults come
 * from {@link DEFAULT_EXTRACTION_DECISION_SETTINGS}.
 */
export interface ExtractionDecisionSettings {
  /** Gate mode; `off` keeps the legacy extraction path and reads no runner. */
  mode: ExtractionMode
  /** Per-decision wire timeout in milliseconds. */
  timeoutMs: number
  /** Upper bound on the estimated tokens of one complete decision state. */
  maxInputTokens: number
  /** Above this many surface events the window extracts directly. */
  maxSurfaceEvents: number
  /** Upper bound on the complete UTF-8 state. */
  maxStateBytes: number
  /** Skip boundary: `p <= skipProbability` may skip (bounded inclusively). */
  skipProbability: number
  /** Every Nth eligible skip becomes an audit extraction instead. */
  auditEveryNSkips: number
  /** Wait before a failed window may be retried. */
  failureCooldownMs: number
  /** LRU cap on idle/cooldown session states with no in-flight work. */
  sessionStateCap: number
}

/** Inclusive bounds of the experimental probability knob. */
export const MIN_SKIP_PROBABILITY = 0
export const MAX_SKIP_PROBABILITY = 0.2

/** Ship defaults (design table): the gate is off unless explicitly enabled. */
export const DEFAULT_EXTRACTION_DECISION_SETTINGS: ExtractionDecisionSettings = Object.freeze({
  mode: 'off',
  timeoutMs: 1500,
  maxInputTokens: 6000,
  maxSurfaceEvents: 64,
  maxStateBytes: 32_768,
  skipProbability: 0.05,
  auditEveryNSkips: 20,
  failureCooldownMs: 30_000,
  sessionStateCap: 200,
})

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/** The three gate modes, enumerated so an unknown value fails the section. */
const ModeSchema = z.union([z.const('off'), z.const('shadow'), z.const('active')])

/**
 * Inner object shape (kebab keys). Absence resolves to defaults via
 * schemastery; a value outside the design-table range throws here, which
 * {@link parseExtractionDecisionSettings} turns into a whole-section rejection.
 */
const SettingsObject = z.object({
  mode: ModeSchema.default(DEFAULT_EXTRACTION_DECISION_SETTINGS.mode),
  'timeout-ms': z.number().min(100).max(5000).default(DEFAULT_EXTRACTION_DECISION_SETTINGS.timeoutMs),
  'max-input-tokens': z
    .number()
    .min(512)
    .max(16_000)
    .default(DEFAULT_EXTRACTION_DECISION_SETTINGS.maxInputTokens),
  'max-surface-events': z
    .number()
    .min(1)
    .max(256)
    .default(DEFAULT_EXTRACTION_DECISION_SETTINGS.maxSurfaceEvents),
  'max-state-bytes': z
    .number()
    .min(4096)
    .max(131_072)
    .default(DEFAULT_EXTRACTION_DECISION_SETTINGS.maxStateBytes),
  'skip-probability': z
    .number()
    .min(MIN_SKIP_PROBABILITY)
    .max(MAX_SKIP_PROBABILITY)
    .default(DEFAULT_EXTRACTION_DECISION_SETTINGS.skipProbability),
  'audit-every-n-skips': z
    .number()
    .min(1)
    .max(1000)
    .default(DEFAULT_EXTRACTION_DECISION_SETTINGS.auditEveryNSkips),
  'failure-cooldown-ms': z
    .number()
    .min(1000)
    .max(300_000)
    .default(DEFAULT_EXTRACTION_DECISION_SETTINGS.failureCooldownMs),
  'session-state-cap': z
    .number()
    .min(1)
    .max(2000)
    .default(DEFAULT_EXTRACTION_DECISION_SETTINGS.sessionStateCap),
})

/**
 * Namespace schema, wrapped in the `z.const(undefined)` union (decision-usage
 * convention) so a genuinely absent namespace stays absent instead of
 * materializing defaults into the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>> =
  opt(SettingsObject) as unknown as z<Record<string, unknown>>

/** An effective-settings reader; the returned snapshot is a frozen value. */
export type ExtractionSettingsReader = () => ExtractionDecisionSettings

const isIntegerIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max

/**
 * Strictly parse one merged `cc-systemone-memory-extraction` section.
 *
 * Schema validation covers types and the design-table ranges; the explicit
 * checks below add what schemastery cannot express (integer bounds, a finite
 * probability, a non-empty alias). Any violation invalidates the WHOLE section
 * (`undefined`) — an invalid configuration is never partially applied.
 * @param raw - the merged section as read from the cascade.
 * @returns the effective camelCase settings, or `undefined` when invalid.
 */
export function parseExtractionDecisionSettings(raw: unknown): ExtractionDecisionSettings | undefined {
  if (raw === undefined) return undefined
  let resolved: Record<string, unknown>
  try {
    // Issue #373 (latent here, scalar-only schema): the cascade read-through
    // serves deep-frozen sections and schemastery re-admission mutates in
    // place — always re-admit a mutable, structure-preserving copy.
    resolved = SettingsObject(copyForMutation(raw) as Record<string, never>) as unknown as Record<string, unknown>
  } catch {
    return undefined
  }
  const mode = resolved.mode
  if (mode !== 'off' && mode !== 'shadow' && mode !== 'active') return undefined
  // Bounds inclusive on both ends; `z.number().max` yields floats, so each
  // integer knob is re-checked as a safe integer in its design-table range.
  if (!isIntegerIn(resolved['timeout-ms'], 100, 5000)) return undefined
  if (!isIntegerIn(resolved['max-input-tokens'], 512, 16_000)) return undefined
  if (!isIntegerIn(resolved['max-surface-events'], 1, 256)) return undefined
  if (!isIntegerIn(resolved['max-state-bytes'], 4096, 131_072)) return undefined
  if (!isIntegerIn(resolved['audit-every-n-skips'], 1, 1000)) return undefined
  if (!isIntegerIn(resolved['failure-cooldown-ms'], 1000, 300_000)) return undefined
  if (!isIntegerIn(resolved['session-state-cap'], 1, 2000)) return undefined
  const skipProbability = resolved['skip-probability']
  if (typeof skipProbability !== 'number' || !Number.isFinite(skipProbability)) return undefined
  if (skipProbability < MIN_SKIP_PROBABILITY || skipProbability > MAX_SKIP_PROBABILITY) return undefined
  return Object.freeze({
    mode,
    timeoutMs: resolved['timeout-ms'] as number,
    maxInputTokens: resolved['max-input-tokens'] as number,
    maxSurfaceEvents: resolved['max-surface-events'] as number,
    maxStateBytes: resolved['max-state-bytes'] as number,
    skipProbability,
    auditEveryNSkips: resolved['audit-every-n-skips'] as number,
    failureCooldownMs: resolved['failure-cooldown-ms'] as number,
    sessionStateCap: resolved['session-state-cap'] as number,
  })
}

/**
 * Wrap a live section reader into an effective-settings snapshot reader.
 *
 * - A read that throws or resolves `undefined` (namespace unregistered, owner
 *   fiber gone) serves the ship defaults: `mode: off` is the safe direction.
 * - An invalid section is rejected as a whole and the previous accepted
 *   snapshot stays effective, so a half-written update never takes effect.
 * @param read - the live section reader.
 * @returns the effective dynamic snapshot reader.
 */
export function createExtractionSettingsReader(
  read: () => Record<string, unknown> | undefined,
): ExtractionSettingsReader {
  let previous: ExtractionDecisionSettings = DEFAULT_EXTRACTION_DECISION_SETTINGS
  return () => {
    let raw: Record<string, unknown> | undefined
    try {
      raw = read()
    } catch {
      return DEFAULT_EXTRACTION_DECISION_SETTINGS
    }
    if (raw === undefined) return DEFAULT_EXTRACTION_DECISION_SETTINGS
    const parsed = parseExtractionDecisionSettings(raw)
    if (parsed === undefined) return previous
    previous = parsed
    return previous
  }
}

/**
 * Register the settings namespace and return the live effective-snapshot
 * reader. Registration never throws across a missing or broken settings layer:
 * an initialisation failure degrades to the ship defaults.
 * @param ctx - the mount context the registration effect binds to.
 * @returns the effective-settings reader.
 */
export function registerExtractionSettings(ctx: Context): ExtractionSettingsReader {
  try {
    const read = registerNamespaceSafe<Record<string, unknown>>(
      ctx,
      SETTINGS_NAMESPACE,
      SettingsSchema as unknown as z<Record<string, unknown>>,
    )
    return createExtractionSettingsReader(read)
  } catch {
    // A failed initialisation must never break mounting: run on the defaults.
    return () => DEFAULT_EXTRACTION_DECISION_SETTINGS
  }
}
