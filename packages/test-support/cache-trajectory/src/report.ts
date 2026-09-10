/**
 * Pure report layer for the cache-hit-rate benchmark: the rate definition,
 * the per-request/session folds, the shape+cache invariant evaluation, the
 * report schema/fold, the console table, and the env threshold knob.
 *
 * Hit-rate definition (unified across the whole plan): `cacheRead / (input + cacheRead)` — the
 * harness TokenUsage buckets are disjoint and `inputTokens` is uncached input
 * only. No cacheWrite exists on DeepSeek, so a cacheWrite bucket never enters
 * the denominator.
 * @module @dsh-cc/cache-trajectory/report
 */

import z from 'zod'

/** One request's usage buckets as folded off the session event log. */
export interface RequestUsageRow {
  /** Zero-based request index in arrival order. */
  readonly index: number
  /** Turn number the request belonged to (from the `assistant/message` event). */
  readonly turn: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** Regression thresholds for one trajectory run. */
export interface Thresholds {
  /** Soft floor for every request after the first, `cacheRead/(input+cacheRead)`. */
  readonly perRequestMinRate: number
  /** Floor for the session aggregate excluding the first request. */
  readonly sessionMinRate: number
}

/**
 * The cache hit rate of one request: `cacheRead / (input + cacheRead)`.
 * Undefined when the provider reported no cache bucket (keyless mock runs) or
 * the denominator is zero.
 */
export function hitRate(usage: {
  inputTokens: number
  cacheReadTokens?: number
}): number | undefined {
  const cached = usage.cacheReadTokens
  if (cached === undefined || cached < 0) return undefined
  const denominator = usage.inputTokens + cached
  if (denominator <= 0) return undefined
  return cached / denominator
}

function sessionRateOf(rows: readonly RequestUsageRow[]): number | undefined {
  let hasCacheBucket = false
  let input = 0
  let cached = 0
  for (const row of rows) {
    input += row.inputTokens
    if (row.cacheReadTokens !== undefined) {
      hasCacheBucket = true
      cached += row.cacheReadTokens
    }
  }
  if (!hasCacheBucket) return undefined
  const denominator = input + cached
  if (denominator <= 0) return undefined
  return cached / denominator
}

/** Per-request rates plus both session aggregates (all requests / excluding the first). */
export interface FoldedRates {
  readonly perRequest: readonly (number | undefined)[]
  readonly session: number | undefined
  readonly sessionExcludingFirst: number | undefined
}

/** Fold per-request rates and the two session aggregates. */
export function foldRates(rows: readonly RequestUsageRow[]): FoldedRates {
  return {
    perRequest: rows.map(row => hitRate(row)),
    session: sessionRateOf(rows),
    sessionExcludingFirst: rows.length >= 2 ? sessionRateOf(rows.slice(1)) : undefined,
  }
}

/** Inputs to the invariant evaluation for one trajectory run. */
export interface InvariantInput {
  readonly rows: readonly RequestUsageRow[]
  readonly thresholds: Thresholds
  /** Lower bound on the total request count — a shape floor, never a ceiling. */
  readonly minRequests: number
  /** False for keyless mock runs: cache criteria leave the verdict entirely. */
  readonly cacheHitsExpected: boolean
  /** `tool/call` events observed on the first turn's turn number. */
  readonly firstTurnToolCalls: number
  /** Whether the trajectory's first turn demands a tool call (default true). */
  readonly firstTurnExpectsToolCall?: boolean
  /** One-based request indices whose `assistant/message` carried no usage. */
  readonly rowsWithoutUsage?: readonly number[]
}

/**
 * Evaluate the run's shape invariants (always) and cache invariants (only when
 * `cacheHitsExpected`). Returns one human-readable line per failure; an empty
 * array means pass. Shape checks are deterministic; the cache floors are
 * deliberately conservative soft limits (see the plan's anti-flaky notes: no
 * upper bounds, env-tunable thresholds).
 */
export function evaluateInvariants(input: InvariantInput): string[] {
  const failures: string[] = []
  const { rows, thresholds, minRequests, cacheHitsExpected, firstTurnToolCalls } = input
  const expectsToolCall = input.firstTurnExpectsToolCall ?? true

  if (rows.length < minRequests) {
    failures.push(
      `expected at least ${minRequests} model requests, saw ${rows.length}`,
    )
  }
  for (const index of input.rowsWithoutUsage ?? []) {
    failures.push(`request ${index} reported no usage`)
  }

  if (expectsToolCall && firstTurnToolCalls < 1) {
    failures.push(
      `the first turn was expected to call a tool but produced ${firstTurnToolCalls}`,
    )
  }

  if (!cacheHitsExpected) return failures

  rows.forEach((row, index) => {
    const requestNumber = index + 1
    if (requestNumber === 1) return
    if ((row.cacheReadTokens ?? 0) <= 0) {
      failures.push(
        `request ${requestNumber} reported no cached input tokens `
          + `(cacheReadTokens=${String(row.cacheReadTokens)})`,
      )
      return
    }
    const rate = hitRate(row)
    if (rate !== undefined && rate < thresholds.perRequestMinRate) {
      failures.push(
        `request ${requestNumber} hit rate ${rate.toFixed(3)} `
          + `below the per-request floor ${thresholds.perRequestMinRate}`,
      )
    }
  })

  const session = foldRates(rows).sessionExcludingFirst
  if (session !== undefined && session < thresholds.sessionMinRate) {
    failures.push(
      `session hit rate excluding the first request ${session.toFixed(3)} `
        + `below the session floor ${thresholds.sessionMinRate}`,
    )
  }

  return failures
}

/** zod schema of a folded report — the on-disk contract for `--out` / `--report-only`. */
export const cacheTrajectoryReportSchema = z.object({
  schemaVersion: z.literal(1),
  trajectory: z.object({
    id: z.string(),
    sessionId: z.string(),
    provider: z.string(),
    model: z.string(),
  }),
  startedAt: z.string(),
  finishedAt: z.string(),
  requests: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      turn: z.number().int().positive(),
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
      cacheReadTokens: z.number().nonnegative().optional(),
      cacheWriteTokens: z.number().nonnegative().optional(),
      hitRate: z.number().min(0).max(1).nullable().optional(),
    }),
  ),
  totals: z.object({
    requests: z.number().int().nonnegative(),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    cacheReadTokens: z.number().nonnegative(),
    cacheWriteTokens: z.number().nonnegative(),
    hitRate: z.number().min(0).max(1).nullable(),
    hitRateExcludingFirst: z.number().min(0).max(1).nullable(),
  }),
  thresholds: z.object({
    perRequestMinRate: z.number().min(0).max(1),
    sessionMinRate: z.number().min(0).max(1),
    minRequests: z.number().int().positive(),
    cacheHitsExpected: z.boolean(),
  }),
  verdict: z.enum(['pass', 'fail']),
  failures: z.array(z.string()),
})

/** A folded trajectory run report (see {@link cacheTrajectoryReportSchema}). */
export type CacheTrajectoryReport = z.infer<typeof cacheTrajectoryReportSchema>

/** Inputs to {@link foldReport} — the run's facts plus the invariant inputs. */
export interface ReportInput extends InvariantInput {
  readonly trajectoryId: string
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly startedAt: string
  readonly finishedAt: string
}

/** Fold one run into a schema-valid report with its verdict. */
export function foldReport(input: ReportInput): CacheTrajectoryReport {
  const rates = foldRates(input.rows)
  const failures = evaluateInvariants(input)
  const sum = (pick: (row: RequestUsageRow) => number): number =>
    input.rows.reduce((total, row) => total + pick(row), 0)

  return {
    schemaVersion: 1,
    trajectory: {
      id: input.trajectoryId,
      sessionId: input.sessionId,
      provider: input.provider,
      model: input.model,
    },
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    requests: input.rows.map((row, index) => {
      const rate = rates.perRequest[index]
      return {
        index: row.index,
        turn: row.turn,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        ...(row.cacheReadTokens !== undefined ? { cacheReadTokens: row.cacheReadTokens } : {}),
        ...(row.cacheWriteTokens !== undefined ? { cacheWriteTokens: row.cacheWriteTokens } : {}),
        ...(rate !== undefined ? { hitRate: rate } : {}),
      }
    }),
    totals: {
      requests: input.rows.length,
      inputTokens: sum(row => row.inputTokens),
      outputTokens: sum(row => row.outputTokens),
      cacheReadTokens: sum(row => row.cacheReadTokens ?? 0),
      cacheWriteTokens: sum(row => row.cacheWriteTokens ?? 0),
      hitRate: rates.session ?? null,
      hitRateExcludingFirst: rates.sessionExcludingFirst ?? null,
    },
    thresholds: {
      perRequestMinRate: input.thresholds.perRequestMinRate,
      sessionMinRate: input.thresholds.sessionMinRate,
      minRequests: input.minRequests,
      cacheHitsExpected: input.cacheHitsExpected,
    },
    verdict: failures.length === 0 ? 'pass' : 'fail',
    failures,
  }
}

/** `87.5%` for a rate, `--` when the provider reported no cache bucket. */
function percentCell(rate: number | null | undefined): string {
  return rate === null || rate === undefined ? '--' : `${(rate * 100).toFixed(1)}%`
}

/**
 * Render the report as an aligned console table: header (trajectory/route/
 * verdict), one row per request, session totals, then the failure lines when
 * the verdict is fail.
 */
export function renderReportTable(report: CacheTrajectoryReport): string {
  const lines: string[] = []
  const verdict = report.verdict === 'pass' ? 'PASS' : 'FAIL'
  lines.push(
    `cache trajectory ${report.trajectory.id} — ${report.trajectory.provider}/${report.trajectory.model} — ${verdict}`,
  )
  lines.push(
    '  #    turn     input   output    cached    rate',
  )
  for (const request of report.requests) {
    const row = [
      `#${String(request.index).padEnd(3)}`,
      String(request.turn).padStart(4),
      String(request.inputTokens).padStart(9),
      String(request.outputTokens).padStart(9),
      String(request.cacheReadTokens ?? 0).padStart(9),
      percentCell(request.hitRate).padStart(8),
    ]
    lines.push(`  ${row.join('  ')}`)
  }
  lines.push(
    `  session hit rate: ${percentCell(report.totals.hitRate)} `
      + `(excluding first request: ${percentCell(report.totals.hitRateExcludingFirst)}) `
      + `over ${report.totals.requests} requests`,
  )
  if (report.failures.length > 0) {
    lines.push('  failures:')
    for (const failure of report.failures) lines.push(`    - ${failure}`)
  }
  return lines.join('\n')
}

/** Environment knob that loosens/tightens both floors at once (`[0,1]`). */
export const CACHE_E2E_MIN_HIT_RATE_ENV = 'DSH_CACHE_E2E_MIN_HIT_RATE'

/**
 * Resolve the effective thresholds: the env knob (when set to a number in
 * `[0,1]`) overrides both floors; anything else keeps the trajectory's own.
 */
export function thresholdsFromEnv(
  base: Thresholds,
  raw: string | undefined,
): Thresholds {
  if (raw === undefined || raw.trim() === '') return base
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 1) return base
  return { perRequestMinRate: value, sessionMinRate: value }
}
