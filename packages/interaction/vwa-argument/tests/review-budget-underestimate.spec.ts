/**
 * Fix 6 review follow-up — budget behavior when the ACTUAL input exceeds the
 * reservation (PR #282 review finding 3).
 *
 * The reservation is an estimate (`bytes/3-estimate`); when the provider reports
 * real usage above it, the settled ledger must carry the actuals and the
 * tracker must still stop subsequent scheduling. Three variants:
 *  1. usage returned (actual > reserved),
 *  2. usage missing (the estimate is charged — documented approximation),
 *  3. the dispatch itself fails (same estimate-charged shape, error row).
 *
 * @module tests/review-budget-underestimate
 */

import { describe, expect, it } from 'vitest'
import { BudgetTracker } from '../src/review-tasks.ts'
import { ReviewBudgetError, ReviewCaller } from '../src/review-call.ts'
import { ReviewConfigDriftError } from '../src/review-adapter.ts'
import type { ReviewBudget } from '../src/review-budget.ts'
import type { ReviewMessages, ReviewModelAdapter } from '../src/review-adapter.ts'
import type { UsageRow } from '../src/review-run-store.ts'

const MESSAGES: ReviewMessages = [{ role: 'user', content: 'task' }]
const SIGNAL = new AbortController().signal
const RESERVED = 30_000
const ACTUAL = 60_000

function budget(over: Partial<ReviewBudget> = {}): ReviewBudget {
  return {
    maxCallsPerRun: 8,
    maxInputTokensPerRun: 100_000,
    maxOutputTokensPerRun: 300_000,
    maxOutputTokensPerCall: 16_000,
    wallMs: 600_000,
    callTimeoutMs: 30_000,
    concurrency: 2,
    ...over,
  }
}

function adapterFor(
  dispatch: () => Promise<{ raw: string; inputTokens?: number; outputTokens?: number }>,
): ReviewModelAdapter {
  return {
    async prepareReviewCall() {
      return {
        describe: () => ({ modelId: 'fake', providerId: 'fake', version: 'unpinned', effectiveOptions: {} }),
        dispatch,
      }
    },
    async countInput() {
      return { tokens: RESERVED, method: 'bytes/3-estimate' as const }
    },
    configFingerprint: () => ({ fake: true }),
  }
}

describe('Fix 6 review — concurrent underestimation', () => {
  it('actual > reserved with two in-flight calls: settled spend is the actual, later calls are refused', async () => {
    const tracker = new BudgetTracker(budget())
    const rows: Omit<UsageRow, 'runId'>[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const adapter = adapterFor(async () => {
      await gate
      return { raw: '{"ok":true}', inputTokens: ACTUAL, outputTokens: 1_000 }
    })
    const caller = new ReviewCaller(adapter, tracker, budget(), SIGNAL, (row) => rows.push(row))
    // Both calls reserve the ESTIMATE (2 × 30,000 = 60,000 ≤ 100,000) and are
    // in flight together; only then do their actuals land.
    const first = caller.call('task_a', MESSAGES, {}, (raw) => raw)
    const second = caller.call('task_b', MESSAGES, {}, (raw) => raw)
    release()
    await Promise.all([first, second])
    // Settled spend carries the ACTUALS: 2 × 60,000 = 120,000 > the 100,000 cap.
    expect(tracker.inputTokens).toBe(2 * ACTUAL)
    // The overrun is reported, not swallowed: the ledger's 'actual' rows carry it.
    const actualRows = rows.filter((row) => row.kind === 'actual')
    expect(actualRows.map((row) => row.inputTokens)).toEqual([ACTUAL, ACTUAL])
    // And subsequent scheduling is still limited by the settled actuals.
    expect(tracker.reserve(1)).toBe(false)
    await expect(caller.call('task_c', MESSAGES, {}, (raw) => raw)).rejects.toBeInstanceOf(ReviewBudgetError)
  })

  it('missing usage: the estimate is charged, so the under-count is bounded and visible', async () => {
    const tracker = new BudgetTracker(budget())
    const rows: Omit<UsageRow, 'runId'>[] = []
    const adapter = adapterFor(async () => ({ raw: '{"ok":true}' }))
    const caller = new ReviewCaller(adapter, tracker, budget(), SIGNAL, (row) => rows.push(row))
    await Promise.all([
      caller.call('task_a', MESSAGES, {}, (raw) => raw),
      caller.call('task_b', MESSAGES, {}, (raw) => raw),
    ])
    // No provider usage: each attempt settles at the 30,000 estimate — the
    // documented approximation (bounded per call, visible in the ledger).
    expect(tracker.inputTokens).toBe(2 * RESERVED)
    expect(rows.filter((row) => row.kind === 'actual').map((row) => row.inputTokens)).toEqual([RESERVED, RESERVED])
    // Two estimates still fit the 100,000 cap, so the next call is admitted;
    // the third would reserve 90,000 and still fit, the fourth would not.
    expect(tracker.reserve(RESERVED)).toBe(true)
  })

  it('a failed dispatch charges the estimate and records an error row', async () => {
    const tracker = new BudgetTracker(budget())
    const rows: Omit<UsageRow, 'runId'>[] = []
    // A PERMANENT-class failure (config drift): one attempt, no retry backoff.
    // The transient-retry path is covered by the review-call specs.
    const adapter = adapterFor(async () => {
      throw new ReviewConfigDriftError('boom')
    })
    const caller = new ReviewCaller(adapter, tracker, budget(), SIGNAL, (row) => rows.push(row))
    await expect(caller.call('task_a', MESSAGES, {}, (raw) => raw)).rejects.toThrow('boom')
    expect(tracker.inputTokens).toBe(RESERVED)
    expect(rows.filter((row) => row.kind === 'error').map((row) => row.inputTokens)).toEqual([RESERVED])
    // The failed attempt's estimate stays charged (crash-safe accounting).
    expect(tracker.reserve(RESERVED)).toBe(true)
  })
})
