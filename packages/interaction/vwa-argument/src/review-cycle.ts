/**
 * Review-cycle budget (§13, §A.4): a continuation never grants a fresh budget.
 *
 * A fresh request (one without `continue`) opens an identified review cycle;
 * continuations bind to the latest cycle at admission. All runs of a cycle share
 * ONE frozen budget for model calls, input tokens and output tokens; a
 * continue run can reserve only what the cycle has left. Wall-clock time stays
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
import { fail, VwaFail, type Fail } from './store.ts'
import { acquireLock, releaseLock } from './lock.ts'
import type { ReviewBudget } from './review-budget.ts'
import type { Id } from './types.ts'

export interface CycleUsage {
  calls: number
  inputTokens: number
  outputTokens: number
}

type Request = Parameters<ReviewRunStore['writeRequest']>[1]
type CycleRequest = Request & { cycleId: Id; cycleSequence: number }
const LEGACY_CYCLE = 'legacy-before-cycle-ids'

function requests(root: string, projectId: Id): Request[] {
  const store = new ReviewRunStore(root, projectId)
  let ids: string[]
  try {
    ids = readdirSync(join(root, '.dsh', 'vwa', projectId, 'review-runs'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error // Never turn an unreadable ledger into free budget.
  }
  return ids.flatMap((id) => {
    const request = store.loadRequest(id)
    return request ? [request] : []
  })
}

function latestCycle(all: Request[]): { cycleId: Id; cycleSequence: number } {
  const latest = all.reduce<Request | undefined>(
    (best, r) => (r.cycleSequence ?? 0) > (best?.cycleSequence ?? 0) ? r : best, undefined,
  )
  return { cycleId: latest?.cycleId ?? LEGACY_CYCLE, cycleSequence: latest?.cycleSequence ?? 0 }
}

/** Short cross-process critical section: no model calls or awaits while held. */
function withBudgetLock<T>(root: string, projectId: Id, action: () => T): T {
  const dir = join(root, '.dsh', 'vwa', projectId, 'review-budget')
  const refusal = acquireLock(dir)
  if (refusal) throw new VwaFail(refusal)
  try { return action() } finally { releaseLock(dir) }
}

/**
 * Assign cycle membership atomically at admission, before a host may queue
 * the run. Fresh requests open a monotonic cycle; continuations bind to the
 * latest admitted cycle. A runner preserves its queued identity, even if a
 * newer fresh request has since opened another cycle. Wall clocks and UUID
 * ordering never determine membership.
 */
export function reserveCycleRequest(
  root: string, projectId: Id, runId: Id, request: Request,
): CycleRequest | Fail {
  try {
    return withBudgetLock(root, projectId, () => {
      const store = new ReviewRunStore(root, projectId)
      const prior = store.readRequest(runId)
      const latest = latestCycle(requests(root, projectId))
      const identity = prior?.cycleId !== undefined
        ? { cycleId: prior.cycleId, cycleSequence: prior.cycleSequence ?? 0 }
        : request.continue === true
          ? latest
          : { cycleId: runId, cycleSequence: latest.cycleSequence + 1 }
      const reserved = { ...request, ...identity, startedAt: prior?.startedAt ?? request.startedAt }
      store.reserveRequest(runId, reserved)
      return reserved
    })
  } catch (error) {
    if (error instanceof VwaFail) return error.fail
    return fail('STORE_IO_FAILED', `review cycle admission failed: ${String(error)}`, true)
  }
}

/**
 * Spend of a specific cycle, or the latest admitted one. An asking run stays
 * bound to its own cycle and is excluded from the returned spend. Legacy
 * requests have no reliable cycle identity: conservatively charge ALL of
 * them to one legacy cycle. A new fresh request opens an independent cycle.
 */
export function cycleUsage(root: string, projectId: Id, excludeRunId?: Id, cycleId?: Id): CycleUsage {
  const all = requests(root, projectId)
  const own = all.find((r) => r.runId === excludeRunId)
  const selected = cycleId ?? (own ? own.cycleId ?? LEGACY_CYCLE : latestCycle(all).cycleId)
  return all.filter((r) => r.runId !== excludeRunId && (r.cycleId ?? LEGACY_CYCLE) === selected)
    .reduce<CycleUsage>((sum, r) => ({
      calls: sum.calls + r.calls,
      inputTokens: sum.inputTokens + r.inputTokens,
      outputTokens: sum.outputTokens + r.outputTokens,
    }), { calls: 0, inputTokens: 0, outputTokens: 0 })
}

/**
 * Check aggregate spend and persist the caller's reservation in ONE critical
 * section. The callback must synchronously reserve locally and append its
 * durable usage row BEFORE returning. Other runs see that row before they
 * can reserve; a crash after it is written still counts against the cycle.
 */
export function reserveCycleCall(
  root: string, projectId: Id, cycleId: Id, budget: ReviewBudget, inputTokens: number,
  reserve: () => boolean,
): boolean {
  return withBudgetLock(root, projectId, () => {
    const used = cycleUsage(root, projectId, undefined, cycleId)
    if (used.calls + 1 > budget.maxCallsPerRun ||
        used.inputTokens + inputTokens > budget.maxInputTokensPerRun ||
        used.outputTokens + budget.maxOutputTokensPerCall > budget.maxOutputTokensPerRun) return false
    return reserve()
  })
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
