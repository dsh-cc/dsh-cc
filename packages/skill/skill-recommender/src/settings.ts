/**
 * Settings for S1-06 skill recommendation: the `cc-skill-recommendation`
 * namespace, whose raw keys are kebab-case and whose internal shape is
 * camelCase.
 *
 * Design: `docs/plans/2026-11-02-systemone-06-skill-recommendation.md`
 * § "Settings and tool contract" (the twelve-row table of keys, types, ranges
 * and defaults) and § "State machine, ordering, and behavior" step 1 (`mode`
 * gates the whole judgment; an invalid section means "do not call the runner").
 *
 * Two halves, mirroring `@dsh-cc/tool-search`'s `discovery-settings.ts` (the
 * `cc-reasoning-fold` / `retry-attendant` precedent):
 *
 * 1. the validated camelCase projection of the table, produced by
 *    {@link parseRecommendationSettings} (kebab raw keys → camelCase fields,
 *    unknown keys ignored per repo convention). A value outside its row is
 *    REJECTED, not clamped: the whole section is refused and the feature reads
 *    as unavailable, exactly as tool-search refuses it;
 * 2. the warn-once reporter ({@link createWarnOnce}) the caller injects to get
 *    "reported once per invalid-settings occurrence" without spamming a warn on
 *    every call.
 *
 * Registration: {@link registerRecommendationSettings} mirrors the table as a
 * schemastery schema (same `.min()`/`.max()` bounds) and registers the
 * namespace idempotently through `registerNamespaceSafe`, which defers itself
 * to `ctx.inject(['settings'])` when the settings plane has not arrived yet —
 * the repo's lazy precedence, never a boot-time hard dependency. The reader it
 * returns reads the RAW section live on every call: there is no frozen
 * snapshot, so a mid-session `mode` change is observed by the next judgment
 * and by the post-await revalidation.
 *
 * @module @dsh-cc/skill-recommender/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings/ns'
import type { SettingsReader } from '@dsh-cc/settings/ns'
import type { RecommendationLimits } from './pool.ts'

/** The settings namespace carrying the recommendation knobs. */
export const SETTINGS_NAMESPACE = 'cc-skill-recommendation'

/** The three modes of the design's `mode` row. */
export const RECOMMENDATION_MODES = ['off', 'shadow', 'active'] as const

/** `off` (the default) returns the off result with zero runner calls. */
export type RecommendationMode = (typeof RECOMMENDATION_MODES)[number]

/**
 * The design's § "Settings and tool contract" table, camelCase: `off` by
 * default (a dark launch), a 1500 ms ceiling across ALL batches, and the
 * first-round evaluation thresholds. These are evaluation parameters, not
 * measured quality guarantees. The judgment half is exactly
 * {@link RecommendationLimits}, so the policy layer consumes the settings value
 * directly; `mode` and the two cache knobs are presentation and reuse.
 */
export interface RecommendationSettings extends RecommendationLimits {
  /** `off` | `shadow` | `active`. */
  readonly mode: RecommendationMode
  /** Cached judgments to retain; `0` disables storage. */
  readonly cacheEntries: number
  /** Entry lifetime in milliseconds; `0` makes no entry reusable. */
  readonly cacheTtlMs: number
}

/** The table's defaults, exactly: a dark launch with the round-one thresholds. */
export const DEFAULT_RECOMMENDATION_SETTINGS: RecommendationSettings = {
  mode: 'off',
  timeoutMs: 1500,
  maxInputTokens: 4096,
  maxCandidates: 64,
  batchSize: 8,
  maxTaskChars: 2048,
  maxMetadataChars: 2048,
  minRelevanceIndex: 3,
  minPrerequisitesMet: 0.8,
  maxRecommendations: 3,
  cacheEntries: 128,
  cacheTtlMs: 60000,
}

/** One rejected raw value, in the user's own kebab-case key vocabulary. */
export interface RecommendationSettingProblem {
  /** The raw settings key (kebab-case), or the namespace name for a malformed section. */
  readonly key: string
  /** The value as written by the user. */
  readonly value: unknown
  /** What the design's table requires, e.g. `integer in 100..5000`. */
  readonly expected: string
}

/** A parsed section that satisfies every row of the design table. */
export interface RecommendationSettingsValid {
  readonly ok: true
  readonly settings: RecommendationSettings
}

/** A parsed section with at least one rejected value; the caller must not run the runner. */
export interface RecommendationSettingsInvalid {
  readonly ok: false
  readonly problems: readonly RecommendationSettingProblem[]
}

/** Result of validating one raw `cc-skill-recommendation` section. */
export type RecommendationSettingsParseResult = RecommendationSettingsValid | RecommendationSettingsInvalid

/** Raw kebab-case key → camelCase field, purely for problem reporting and tests. */
const RAW_KEYS = {
  mode: 'mode',
  timeoutMs: 'timeout-ms',
  maxInputTokens: 'max-input-tokens',
  maxCandidates: 'max-candidates',
  batchSize: 'batch-size',
  maxTaskChars: 'max-task-chars',
  maxMetadataChars: 'max-metadata-chars',
  minRelevanceIndex: 'min-relevance-index',
  minPrerequisitesMet: 'min-prerequisites-met',
  maxRecommendations: 'max-recommendations',
  cacheEntries: 'cache-entries',
  cacheTtlMs: 'cache-ttl-ms',
} as const satisfies Record<keyof RecommendationSettings, string>

/** Read an absent value as its default; collect anything else that breaks the row. */
function readInt(
  raw: Record<string, unknown>,
  field: keyof RecommendationSettings,
  min: number,
  max: number,
  fallback: number,
  problems: RecommendationSettingProblem[],
): number {
  const key = RAW_KEYS[field]
  const value = raw[key]
  if (value === undefined) return fallback
  const expected = `integer in ${min}..${max}`
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    problems.push({ key, value, expected })
    return fallback
  }
  return value
}

/** Read a fractional threshold (`min-relevance-index`, `min-prerequisites-met`). */
function readNumber(
  raw: Record<string, unknown>,
  field: keyof RecommendationSettings,
  min: number,
  max: number,
  fallback: number,
  problems: RecommendationSettingProblem[],
): number {
  const key = RAW_KEYS[field]
  const value = raw[key]
  if (value === undefined) return fallback
  // `NaN`/`Infinity` would silently disable a comparison, so both are rejected.
  const expected = `finite number in ${min}..${max}`
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    problems.push({ key, value, expected })
    return fallback
  }
  return value
}

/**
 * Validate one raw `cc-skill-recommendation` section against the design's table.
 *
 * An absent section (or an absent key) resolves to the default; a value that
 * violates the row's type or range is collected as a
 * {@link RecommendationSettingProblem} and the whole section is refused — the
 * table is a contract, never a suggestion to clamp. Unknown keys are ignored
 * (repo convention), so a newer config never breaks an older build.
 * @param raw - the raw namespace section (any shape; junk is reported, not thrown on).
 * @returns the camelCase settings, or every problem found.
 */
export function parseRecommendationSettings(raw: unknown): RecommendationSettingsParseResult {
  if (raw === undefined || raw === null) return { ok: true, settings: DEFAULT_RECOMMENDATION_SETTINGS }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      problems: [{ key: SETTINGS_NAMESPACE, value: raw, expected: 'object of kebab-case keys' }],
    }
  }
  const section = raw as Record<string, unknown>
  const problems: RecommendationSettingProblem[] = []
  const defaults = DEFAULT_RECOMMENDATION_SETTINGS

  // `mode` — one of the three literals; anything else leaves the feature off.
  const rawMode = section[RAW_KEYS.mode]
  const modeIsValid = (RECOMMENDATION_MODES as readonly unknown[]).includes(rawMode)
  const mode: RecommendationMode = modeIsValid ? rawMode as RecommendationMode : defaults.mode
  if (rawMode !== undefined && !modeIsValid) {
    problems.push({ key: RAW_KEYS.mode, value: rawMode, expected: RECOMMENDATION_MODES.join(' | ') })
  }

  const settings: RecommendationSettings = {
    mode,
    // `timeout-ms` is the ceiling for the whole judgment, all batches included.
    timeoutMs: readInt(section, 'timeoutMs', 100, 5000, defaults.timeoutMs, problems),
    maxInputTokens: readInt(section, 'maxInputTokens', 512, 16384, defaults.maxInputTokens, problems),
    maxCandidates: readInt(section, 'maxCandidates', 1, 128, defaults.maxCandidates, problems),
    batchSize: readInt(section, 'batchSize', 1, 16, defaults.batchSize, problems),
    maxTaskChars: readInt(section, 'maxTaskChars', 64, 8192, defaults.maxTaskChars, problems),
    maxMetadataChars: readInt(section, 'maxMetadataChars', 128, 8192, defaults.maxMetadataChars, problems),
    minRelevanceIndex: readNumber(section, 'minRelevanceIndex', 0, 4, defaults.minRelevanceIndex, problems),
    minPrerequisitesMet: readNumber(section, 'minPrerequisitesMet', 0, 1, defaults.minPrerequisitesMet, problems),
    maxRecommendations: readInt(section, 'maxRecommendations', 1, 10, defaults.maxRecommendations, problems),
    // `cache-entries: 0` disables storage; `cache-ttl-ms: 0` makes no entry reusable.
    cacheEntries: readInt(section, 'cacheEntries', 0, 1024, defaults.cacheEntries, problems),
    cacheTtlMs: readInt(section, 'cacheTtlMs', 0, 300000, defaults.cacheTtlMs, problems),
  }
  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, settings }
}

/** Render an invalid parse as the single operator-facing line the reporter emits. */
export function describeRecommendationSettingsProblems(
  problems: readonly RecommendationSettingProblem[],
): string {
  const detail = problems
    .map(problem => `${problem.key} must be ${problem.expected} (got ${JSON.stringify(problem.value) ?? 'undefined'})`)
    .join('; ')
  return `${SETTINGS_NAMESPACE}: invalid settings — returning unavailable with no decision runner: ${detail}`
}

/** The injected warn sink plus its single-shot bookkeeping. */
export interface InvalidSettingsReporter {
  /**
   * Report a parse result. Warns at most once per DISTINCT invalid
   * configuration: repeating the same invalid values on every call emits one
   * warning, while a changed (still invalid) configuration is reported again.
   * A valid result emits nothing.
   */
  report(result: RecommendationSettingsParseResult): void
  /** Forget what was already reported (plugin reload, or after a settings write). */
  reset(): void
}

/**
 * Build the warn-once reporter the fail-soft settings path asks for:
 * `ctx.logger.warn` fires at most once per invalid-settings occurrence, never
 * on the hot path more than that.
 * @param warn - the injected sink (usually `message => ctx.logger.warn(message)`).
 * @returns the reporter to hand to {@link registerRecommendationSettings}.
 */
export function createWarnOnce(warn: (message: string) => void): InvalidSettingsReporter {
  let lastReported: string | undefined
  return {
    report(result) {
      if (result.ok) return
      const signature = JSON.stringify(result.problems.map(problem => [problem.key, problem.expected, problem.value]))
      if (signature === lastReported) return
      lastReported = signature
      warn(describeRecommendationSettingsProblems(result.problems))
    },
    reset() {
      lastReported = undefined
    },
  }
}

/**
 * Resolve the live settings for one call.
 *
 * This is the runner gate: `undefined` means "invalid configuration — do not
 * call the runner, return unavailable", and the failure has been reported once
 * through the injected reporter.
 * @param raw - the raw `cc-skill-recommendation` section, or `undefined` when absent.
 * @param reporter - the warn-once sink; omitted only in tests.
 * @returns validated settings, or `undefined` when the configuration is invalid.
 */
export function resolveRecommendationSettings(
  raw: unknown,
  reporter?: InvalidSettingsReporter,
): RecommendationSettings | undefined {
  const parsed = parseRecommendationSettings(raw)
  if (parsed.ok) return parsed.settings
  reporter?.report(parsed)
  return undefined
}

/** `z.union([t, z.const(undefined)])`: an absent namespace stays absent. */
const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/**
 * The design's table as a schemastery shape: raw kebab-case keys with the same
 * `.min()`/`.max()` bounds {@link parseRecommendationSettings} enforces. The
 * bounds are mirrored, not moved — schemastery rejects a malformed user layer
 * at publish time so a typo never reaches a judgment, while the parse stays the
 * authoritative gate for callers reading a raw section (integer-ness is not
 * expressible in schemastery).
 */
const RecommendationSettingsObject = z.object({
  mode: z.union([z.const('off'), z.const('shadow'), z.const('active')]).default(DEFAULT_RECOMMENDATION_SETTINGS.mode),
  'timeout-ms': z.number().min(100).max(5000).default(DEFAULT_RECOMMENDATION_SETTINGS.timeoutMs),
  'max-input-tokens': z.number().min(512).max(16384).default(DEFAULT_RECOMMENDATION_SETTINGS.maxInputTokens),
  'max-candidates': z.number().min(1).max(128).default(DEFAULT_RECOMMENDATION_SETTINGS.maxCandidates),
  'batch-size': z.number().min(1).max(16).default(DEFAULT_RECOMMENDATION_SETTINGS.batchSize),
  'max-task-chars': z.number().min(64).max(8192).default(DEFAULT_RECOMMENDATION_SETTINGS.maxTaskChars),
  'max-metadata-chars': z.number().min(128).max(8192).default(DEFAULT_RECOMMENDATION_SETTINGS.maxMetadataChars),
  'min-relevance-index': z.number().min(0).max(4).default(DEFAULT_RECOMMENDATION_SETTINGS.minRelevanceIndex),
  'min-prerequisites-met': z.number().min(0).max(1).default(DEFAULT_RECOMMENDATION_SETTINGS.minPrerequisitesMet),
  'max-recommendations': z.number().min(1).max(10).default(DEFAULT_RECOMMENDATION_SETTINGS.maxRecommendations),
  'cache-entries': z.number().min(0).max(1024).default(DEFAULT_RECOMMENDATION_SETTINGS.cacheEntries),
  'cache-ttl-ms': z.number().min(0).max(300000).default(DEFAULT_RECOMMENDATION_SETTINGS.cacheTtlMs),
})

/**
 * Namespace schema, wrapped in the `z.const(undefined)` union (the
 * `cc-reasoning-fold` / `retry-attendant` convention) so a genuinely absent
 * namespace never materializes defaults into the cascade; the defaults then
 * come from {@link DEFAULT_RECOMMENDATION_SETTINGS} on read.
 */
export const RecommendationSettingsSchema: z<Record<string, unknown>> =
  opt(RecommendationSettingsObject) as unknown as z<Record<string, unknown>>

/** The live reader the wiring layer holds: `undefined` means "do not judge". */
export type RecommendationSettingsReader = () => RecommendationSettings | undefined

/**
 * Register the `cc-skill-recommendation` namespace and return the live reader.
 *
 * Follows the settings-plane discipline: registration is idempotent and
 * deferred until the settings service exists, an absent or refusing settings
 * plane reads as the documented defaults (`mode: off`), and an invalid section
 * is reported ONCE and then reads `undefined` — the caller's "no runner call,
 * return unavailable" gate.
 * @param ctx - the mount context; registration effects bind here.
 * @param reporter - the warn-once sink (`createWarnOnce` over `ctx.logger.warn`).
 * @returns a per-use reader of the validated camelCase settings.
 */
export function registerRecommendationSettings(
  ctx: Context,
  reporter?: InvalidSettingsReporter,
): RecommendationSettingsReader {
  let read: SettingsReader<Record<string, unknown>>
  try {
    read = registerNamespaceSafe<Record<string, unknown>>(
      ctx,
      SETTINGS_NAMESPACE as SettingsNamespace,
      RecommendationSettingsSchema,
    )
  } catch {
    // A settings layer that refuses registration must never break mounting;
    // absent reads keep the feature off.
    return () => DEFAULT_RECOMMENDATION_SETTINGS
  }
  return () => {
    let raw: Record<string, unknown> | undefined
    try {
      raw = read()
    } catch (error) {
      // The schema rejected the user layer on the settings-ns path: report it
      // once and refuse to judge instead of throwing into a tool call.
      reporter?.report({
        ok: false,
        problems: [{
          key: SETTINGS_NAMESPACE,
          value: error instanceof Error ? error.message : String(error),
          expected: 'a valid cc-skill-recommendation section',
        }],
      })
      return undefined
    }
    return resolveRecommendationSettings(raw, reporter)
  }
}
