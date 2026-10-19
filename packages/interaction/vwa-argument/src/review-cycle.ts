/**
 * Review-cycle budget (§13, §A.4): a continuation never grants a fresh budget.
 *
 * A review cycle is the project's most recent fresh request (one without
 * `continue`) plus every continue request after it. All runs of a cycle share
 * ONE frozen budget for model calls, input tokens and output tokens; a
 * continue run receives only what the cycle has left. Wall-clock time stays
 * per run (a liveness limit, not spend). A continuation whose cycle cannot
 * fit one more call is refused with BUDGET_EXHAUSTED before anything is
 * reserved. A fresh request (a second opinion, or a review after a repair)
 * opens a new cycle; how many of those an agent may make is governed by the
 * repair rules, not by this module.
 *
 * Usage per run comes from `loadRequest`, which reconciles the persisted
 * totals with the usage ledger, so a crashed run's reserved calls still count.
 *
 * @module @dsh-cc/vwa-argument/review-cycle
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ReviewRunStore } from './review-run-store.ts'
import { fail, type Fail } from './store.ts'
import type { ReviewBudget } from './review-budget.ts'
import type { Id } from './types.ts'

export interface CycleUsage {
  calls: number
  inputTokens: number
  outputTokens: number
}

/** Spend of the current review cycle, excluding `excludeRunId` (the run asking). */
export function cycleUsage(root: string, projectId: Id, excludeRunId?: Id): CycleUsage {
  const store = new ReviewRunStore(root, projectId)
  let runIds: string[]
  try {
    runIds = readdirSync(join(root, '.dsh', 'vwa', projectId, 'review-runs'))
  } catch {
    runIds = []
  }
  const requests = runIds
    .filter((id) => id !== excludeRunId)
    .flatMap((id) => {
      const request = store.loadRequest(id)
      return request ? [request] : []
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId))
  let start = 0
  requests.forEach((request, i) => {
    if (request.continue !== true) start = i
  })
  return requests.slice(start).reduce<CycleUsage>(
    (sum, r) => ({
      calls: sum.calls + r.calls,
      inputTokens: sum.inputTokens + r.inputTokens,
      outputTokens: sum.outputTokens + r.outputTokens,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0 },
  )
}

/** The budget a continue run may still spend in its cycle. */
export function remainingCycleBudget(budget: ReviewBudget, used: CycleUsage): ReviewBudget {
  return {
    ...budget,
    maxCallsPerRun: Math.max(0, budget.maxCallsPerRun - used.calls),
    maxInputTokensPerRun: Math.max(0, budget.maxInputTokensPerRun - used.inputTokens),
    maxOutputTokensPerRun: Math.max(0, budget.maxOutputTokensPerRun - used.outputTokens),
  }
}

/** BUDGET_EXHAUSTED when the cycle cannot fit one more call (same predicate as BudgetTracker.reserve). */
export function cycleBudgetRefusal(budget: ReviewBudget, used: CycleUsage): Fail | undefined {
  const left = remainingCycleBudget(budget, used)
  if (left.maxCallsPerRun >= 1 && left.maxInputTokensPerRun > 0 && left.maxOutputTokensPerRun >= budget.maxOutputTokensPerCall)
    return undefined
  return fail(
    'BUDGET_EXHAUSTED',
    'The frozen review budget of this review cycle is spent; continue cannot grant more. Report the unresolved items, or start a fresh request only within the repair rules.',
    false,
  )
}
