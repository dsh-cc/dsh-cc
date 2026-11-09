/**
 * Settings for S1-05 tool discovery: the `cc-tool-discovery` namespace, whose
 * raw keys are kebab-case and whose internal shape is camelCase.
 *
 * Design: `docs/plans/2026-11-02-systemone-05-tool-discovery.md` § "Settings"
 * (the thirteen-row table of keys, types, ranges and defaults) and § "Lifecycle,
 * cache, and failure handling" (the fail-soft gate): when ANY setting is
 * invalid the decision runner is NOT called, the original lexical path runs,
 * and the failure is reported ONCE through the settings-namespace error path.
 *
 * Two halves, mirroring the `cc-reasoning-fold` / `retry-attendant` precedent:
 *
 * 1. the validated camelCase projection of the table, produced by
 *    {@link parseDiscoverySettings} (kebab raw keys → camelCase fields,
 *    unknown keys ignored per repo convention);
 * 2. the warn-once reporter ({@link createWarnOnce}) the caller injects to get
 *    "reported once per invalid-settings occurrence" without spamming a warn on
 *    every search.
 *
 * Registration note (scope of this slice): the `registerNamespaceSafe` call
 * itself is not here yet. Importing `@dsh-cc/settings-ns` /
 * `@deepseek-ai/schemastery` from this package requires the manifest amendment
 * the design's § "File responsibilities" table already schedules for
 * `packages/core/tool-search/package.json` (peer+dev dependencies) together
 * with matching `references` entries in this package's `tsconfig.json`;
 * without them `tsc -b packages/core/tool-search` fails on TS2307/TS6059.
 * Everything the runner gate needs — namespace name, defaults table, range
 * validation, single-shot reporting — is dependency-free and lives here, so
 * landing the schema (`z.object` with the same `.min()/.max()` values) and the
 * registration is a self-contained follow-up.
 *
 * @module @dsh-cc/tool-search/discovery-settings
 */

import type { DiscoverySettings } from './discovery.ts'

export type { DiscoverySettings }

/** The settings namespace carrying the discovery knobs (design § "Settings"). */
export const SETTINGS_NAMESPACE = 'cc-tool-discovery'

/** The three modes of the design's `mode` row. */
export const DISCOVERY_MODES = ['off', 'shadow', 'active'] as const

/** `off` preserves the existing lexical path with zero runner calls. */
export type DiscoveryMode = (typeof DISCOVERY_MODES)[number]

/**
 * The design's § "Settings" table, exactly: `off` by default (a dark launch),
 * `gauge` as the route alias, a 1200 ms transaction ceiling, and the first-round
 * evaluation thresholds. These are evaluation parameters, not measured quality
 * guarantees.
 */
export const DEFAULT_DISCOVERY_SETTINGS: DiscoverySettings = {
  mode: 'off',
  routeAlias: 'gauge',
  timeoutMs: 1200,
  maxInputTokens: 4096,
  maxCandidates: 64,
  batchSize: 8,
  maxQueryChars: 2048,
  maxMetadataChars: 2048,
  minRelevanceIndex: 3,
  minDirectFit: 0.75,
  maxActivations: 3,
  cacheEntries: 128,
  cacheTtlMs: 60000,
}

/** One rejected raw value, in the user's own kebab-case key vocabulary. */
export interface DiscoverySettingProblem {
  /** The raw settings key (kebab-case), or the namespace name for a malformed section. */
  readonly key: string
  /** The value as written by the user. */
  readonly value: unknown
  /** What the design's table requires, e.g. `integer in 100..5000`. */
  readonly expected: string
}

/** A parsed section that satisfies every row of the design table. */
export interface DiscoverySettingsValid {
  readonly ok: true
  readonly settings: DiscoverySettings
}

/** A parsed section with at least one rejected value; the caller must not run the runner. */
export interface DiscoverySettingsInvalid {
  readonly ok: false
  readonly problems: readonly DiscoverySettingProblem[]
}

/** Result of validating one raw `cc-tool-discovery` section. */
export type DiscoverySettingsParseResult = DiscoverySettingsValid | DiscoverySettingsInvalid

/** Raw kebab-case key → camelCase field, purely for problem reporting and tests. */
const RAW_KEYS = {
  mode: 'mode',
  routeAlias: 'route-alias',
  timeoutMs: 'timeout-ms',
  maxInputTokens: 'max-input-tokens',
  maxCandidates: 'max-candidates',
  batchSize: 'batch-size',
  maxQueryChars: 'max-query-chars',
  maxMetadataChars: 'max-metadata-chars',
  minRelevanceIndex: 'min-relevance-index',
  minDirectFit: 'min-direct-fit',
  maxActivations: 'max-activations',
  cacheEntries: 'cache-entries',
  cacheTtlMs: 'cache-ttl-ms',
} as const satisfies Record<keyof DiscoverySettings, string>

/** Read an absent value as its default; collect anything else that breaks the row. */
function readInt(
  raw: Record<string, unknown>,
  field: keyof DiscoverySettings,
  min: number,
  max: number,
  fallback: number,
  problems: DiscoverySettingProblem[],
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

/** Read a fractional threshold (`min-relevance-index`, `min-direct-fit`). */
function readNumber(
  raw: Record<string, unknown>,
  field: keyof DiscoverySettings,
  min: number,
  max: number,
  fallback: number,
  problems: DiscoverySettingProblem[],
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
 * Validate one raw `cc-tool-discovery` section against the design's table.
 *
 * An absent section (or an absent key) resolves to the default; a value that
 * violates the row's type or range is collected as a {@link DiscoverySettingProblem}
 * and the whole section is refused. Unknown keys are ignored (repo convention),
 * so a newer config never breaks an older build.
 * @param raw - the raw namespace section (any shape; junk is reported, not thrown on).
 * @returns the camelCase settings, or every problem found.
 */
export function parseDiscoverySettings(raw: unknown): DiscoverySettingsParseResult {
  if (raw === undefined || raw === null) return { ok: true, settings: DEFAULT_DISCOVERY_SETTINGS }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      problems: [{ key: SETTINGS_NAMESPACE, value: raw, expected: 'object of kebab-case keys' }],
    }
  }
  const section = raw as Record<string, unknown>
  const problems: DiscoverySettingProblem[] = []
  const defaults = DEFAULT_DISCOVERY_SETTINGS

  // `mode` — one of the three literals; anything else leaves the feature off.
  const rawMode = section[RAW_KEYS.mode]
  const modeIsValid = (DISCOVERY_MODES as readonly unknown[]).includes(rawMode)
  const mode: DiscoveryMode = modeIsValid ? rawMode as DiscoveryMode : defaults.mode
  if (rawMode !== undefined && !modeIsValid) {
    problems.push({ key: RAW_KEYS.mode, value: rawMode, expected: DISCOVERY_MODES.join(' | ') })
  }

  // `route-alias` — a non-empty configured alias. Whether the alias is actually
  // configured (and therefore not a model literal, which the design rejects)
  // is decided by `identifyRoute`: only the route resolver knows the configured
  // alias set, and a literal simply fails to resolve to a route, which falls
  // back to the lexical path without a model call.
  const rawAlias = section[RAW_KEYS.routeAlias]
  const aliasIsValid = typeof rawAlias === 'string' && rawAlias.trim().length > 0
  const routeAlias = aliasIsValid ? (rawAlias as string).trim() : defaults.routeAlias
  if (rawAlias !== undefined && !aliasIsValid) {
    problems.push({ key: RAW_KEYS.routeAlias, value: rawAlias, expected: 'non-empty string' })
  }

  const settings: DiscoverySettings = {
    mode,
    routeAlias,
    // `timeout-ms` is the ceiling for the whole transaction.
    timeoutMs: readInt(section, 'timeoutMs', 100, 5000, defaults.timeoutMs, problems),
    maxInputTokens: readInt(section, 'maxInputTokens', 512, 16384, defaults.maxInputTokens, problems),
    maxCandidates: readInt(section, 'maxCandidates', 1, 128, defaults.maxCandidates, problems),
    batchSize: readInt(section, 'batchSize', 1, 16, defaults.batchSize, problems),
    maxQueryChars: readInt(section, 'maxQueryChars', 64, 8192, defaults.maxQueryChars, problems),
    maxMetadataChars: readInt(section, 'maxMetadataChars', 128, 8192, defaults.maxMetadataChars, problems),
    minRelevanceIndex: readNumber(section, 'minRelevanceIndex', 0, 4, defaults.minRelevanceIndex, problems),
    minDirectFit: readNumber(section, 'minDirectFit', 0, 1, defaults.minDirectFit, problems),
    maxActivations: readInt(section, 'maxActivations', 1, 20, defaults.maxActivations, problems),
    // `cache-entries: 0` disables storage; `cache-ttl-ms: 0` makes no entry reusable.
    cacheEntries: readInt(section, 'cacheEntries', 0, 1024, defaults.cacheEntries, problems),
    cacheTtlMs: readInt(section, 'cacheTtlMs', 0, 300000, defaults.cacheTtlMs, problems),
  }
  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, settings }
}

/** Render an invalid parse as the single operator-facing line the reporter emits. */
export function describeDiscoverySettingsProblems(problems: readonly DiscoverySettingProblem[]): string {
  const detail = problems
    .map(problem => `${problem.key} must be ${problem.expected} (got ${JSON.stringify(problem.value) ?? 'undefined'})`)
    .join('; ')
  return `${SETTINGS_NAMESPACE}: invalid settings — running the lexical path with no decision runner: ${detail}`
}

/** The injected warn sink plus its single-shot bookkeeping. */
export interface InvalidSettingsReporter {
  /**
   * Report a parse result. Warns at most once per DISTINCT invalid
   * configuration: repeating the same invalid values on every search emits one
   * warning, while a changed (still invalid) configuration is reported again.
   * A valid result emits nothing.
   */
  report(result: DiscoverySettingsParseResult): void
  /** Forget what was already reported (plugin reload, or after a settings write). */
  reset(): void
}

/**
 * Build the warn-once reporter the design's § "Settings" fail-soft path asks
 * for: `ctx.logger.warn` fires at most once per invalid-settings occurrence,
 * never on the hot path more than that.
 * @param warn - the injected sink (usually `message => ctx.logger.warn(message)`).
 * @returns the reporter to hand to {@link resolveDiscoverySettings}.
 */
export function createWarnOnce(warn: (message: string) => void): InvalidSettingsReporter {
  let lastReported: string | undefined
  return {
    report(result) {
      if (result.ok) return
      const signature = JSON.stringify(result.problems.map(problem => [problem.key, problem.expected, problem.value]))
      if (signature === lastReported) return
      lastReported = signature
      warn(describeDiscoverySettingsProblems(result.problems))
    },
    reset() {
      lastReported = undefined
    },
  }
}

/**
 * Resolve the live settings for one search.
 *
 * This is the runner gate of the design's § "Settings" contract: `undefined`
 * means "invalid configuration — do not call the runner, run the lexical path",
 * and the failure has been reported once through the injected reporter.
 * @param raw - the raw `cc-tool-discovery` section, or `undefined` when absent.
 * @param reporter - the warn-once sink; omitted only in tests.
 * @returns validated settings, or `undefined` when the configuration is invalid.
 */
export function resolveDiscoverySettings(
  raw: unknown,
  reporter?: InvalidSettingsReporter,
): DiscoverySettings | undefined {
  const parsed = parseDiscoverySettings(raw)
  if (parsed.ok) return parsed.settings
  reporter?.report(parsed)
  return undefined
}
