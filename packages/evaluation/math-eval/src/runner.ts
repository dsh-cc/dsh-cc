/**
 * Config-runner skeleton (docs/plans/2026-11-21-mathematical-research-harness.md
 * §8.2 metrics, §8.3 budget semantics).
 *
 * `runConfig` is a stub: it validates its arguments (an unknown config key is a
 * programming error) and returns a structured `not-implemented` report. The
 * real runner — one main-conversation model lane, fixed caps, early stop
 * allowed, unused budget reported — lands in a later wave. No model calls here.
 *
 * @module @dsh-cc/math-eval/runner
 */

import { getConfig } from './ablation.js'
import type { ConfigKey, RunManifest } from './types.js'

/** One benchmark problem handed to a config run (§8.1 slices, pinned in gold-set.json). */
export interface EvalProblem {
  problemId: string
  /** Path to the reference formalization artifact (trusted anchor, §4.3). */
  statementFile: string
}

/** Per-problem actual usage, reported alongside the score (§8.2). */
export interface ProblemUsage {
  problemId: string
  promptTokens: number
  completionTokens: number
  wallClockMs: number
  solved: boolean
}

/** Aggregate usage for the run; unused budget is reported, never forced spent. */
export interface RunUsage {
  promptTokens: number
  completionTokens: number
  wallClockMs: number
  solved: number
  attempted: number
}

/** Cost per solved problem; `null` when nothing was solved (no ratio exists). */
export interface RunReportMetrics {
  passAt1: number | null
  tokensPerSolved: number | null
  wallClockPerSolved: number | null
}

/** Structured run report; per-problem usage plus aggregates (§8.2). */
export interface RunReport {
  configKey: ConfigKey
  status: 'not-implemented'
  reason: string
  /** Config flags actually applied (F1's attemptsOverride included as data). */
  config: ReturnType<typeof getConfig>
  problemIds: string[]
  problems: ProblemUsage[]
  usage: RunUsage
  metrics: RunReportMetrics
}

const EMPTY_REPORT_METRICS: RunReportMetrics = {
  passAt1: null,
  tokensPerSolved: null,
  wallClockPerSolved: null,
}

/**
 * Run one ablation config over a problem list.
 *
 * Stub: returns a report with empty per-problem rows and zeroed usage. The
 * manifest is echoed only through its budget envelope size so callers can
 * assert they passed a validated manifest; no run artifacts are written.
 */
export async function runConfig(
  configKey: ConfigKey,
  problems: readonly EvalProblem[],
  manifest: RunManifest,
): Promise<RunReport> {
  const config = getConfig(configKey)
  const attempts = config.attemptsOverride ?? manifest.budget.attempts
  return {
    configKey,
    status: 'not-implemented',
    reason:
      `runConfig is a Wave 1b skeleton: ${problems.length} problem(s) requested for ` +
      `${config.label} at ${attempts} attempt(s); the execution loop lands in a later wave`,
    config,
    problemIds: problems.map((problem) => problem.problemId),
    problems: [],
    usage: { promptTokens: 0, completionTokens: 0, wallClockMs: 0, solved: 0, attempted: 0 },
    metrics: { ...EMPTY_REPORT_METRICS },
  }
}
