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
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { ReviewRunStore } from './review-run-store.ts'
import { fail, ProjectStore, VwaFail, type Fail } from './store.ts'
import { stableJson } from './schema.ts'
import { acquireLock, releaseLock } from './lock.ts'
import type { ReviewBudget } from './review-budget.ts'
import type { ProjectBudget } from './review-config.ts'
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

function sumUsage(rows: Request[]): CycleUsage {
  return rows.reduce<CycleUsage>((sum, r) => ({
    calls: sum.calls + r.calls,
    inputTokens: sum.inputTokens + r.inputTokens,
    outputTokens: sum.outputTokens + r.outputTokens,
  }), { calls: 0, inputTokens: 0, outputTokens: 0 })
}

function cycleSpend(all: Request[], excludeRunId?: Id, cycleId?: Id): CycleUsage {
  const own = all.find((r) => r.runId === excludeRunId)
  const selected = cycleId ?? (own ? own.cycleId ?? LEGACY_CYCLE : latestCycle(all).cycleId)
  return sumUsage(all.filter((r) => r.runId !== excludeRunId && (r.cycleId ?? LEGACY_CYCLE) === selected))
}

/**
 * The project head revision at admission — the revision whose snapshot the
 * cycle's budget was computed from. Production admission pre-reads a valid
 * HEAD (tools.ts fails the request otherwise); an unreadable head (no
 * project at all) yields 0, which no committed revision can be behind.
 */
function headRevisionOf(root: string, projectId: Id): number {
  const head = new ProjectStore(root, projectId).readHead()
  return head.ok ? head.data.head.revision : 0
}

/** Short cross-process critical section: no model calls or awaits while held. */
function withBudgetLock<T>(root: string, projectId: Id, action: () => T): T {
  const dir = join(root, '.dsh', 'vwa', projectId, 'review-budget')
  const refusal = acquireLock(dir)
  if (refusal) throw new VwaFail(refusal)
  try { return action() } finally { releaseLock(dir) }
}

/**
 * F3.4: a cycle's persisted budget lives in its OWN sidecar file, never as a
 * field of the lead request record — a running task periodically writes its
 * whole in-memory request record back (usage rows), which would silently
 * revert a budget field revised mid-run. All readers/writers go through
 * withBudgetLock, so the writes are serialized; the record also carries the
 * project revision that produced it, so a STALE sync (committed before a
 * newer revision) can never overwrite a newer budget.
 */
interface CycleBudgetRecord {
  /** The project head revision that produced this budget; 0 = admission baseline. */
  revision: number
  budget: ReviewBudget
}

function cycleBudgetPath(root: string, projectId: Id, cycleId: Id): string {
  return join(root, '.dsh', 'vwa', projectId, 'review-cycles', `${cycleId}.json`)
}

/**
 * The cycle's budget, or undefined for a LEGACY cycle (no sidecar — the
 * caller's budget governs). A present-but-CORRUPT file throws: falling back
 * to a stale budget would admit over-limit calls, so the reservation path
 * must fail closed (the runner surfaces this as a budget refusal).
 */
export function readCycleBudget(root: string, projectId: Id, cycleId: Id): ReviewBudget | undefined {
  const path = cycleBudgetPath(root, projectId, cycleId)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw corruptCycleBudget(cycleId, error)
  }
  let record: unknown
  try {
    record = JSON.parse(text)
  } catch (error) {
    throw corruptCycleBudget(cycleId, error)
  }
  if (
    typeof record !== 'object' || record === null ||
    typeof (record as CycleBudgetRecord).revision !== 'number' ||
    typeof (record as CycleBudgetRecord).budget !== 'object' || (record as CycleBudgetRecord).budget === null
  ) {
    throw corruptCycleBudget(cycleId, new Error('unexpected sidecar shape'))
  }
  return (record as CycleBudgetRecord).budget
}

function corruptCycleBudget(cycleId: Id, cause: unknown): VwaFail {
  return new VwaFail(fail(
    'STORE_IO_FAILED',
    `the review-cycle budget ledger for cycle ${cycleId} is corrupt; refusing to reserve against a damaged file: ${String(cause)}`,
    false,
  ))
}

/** Tolerant read for the update path: corrupt/absent records are simply overwritten (repaired). */
function readCycleBudgetRecordTolerant(root: string, projectId: Id, cycleId: Id): CycleBudgetRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cycleBudgetPath(root, projectId, cycleId), 'utf8')) as CycleBudgetRecord
    return typeof parsed.revision === 'number' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Atomic sidecar write: a temp file is fsynced and RENAMED over the target —
 * a crash can never leave a half-written budget file behind (a torn file
 * would otherwise fail the reservation path closed or, worse, fall back to
 * a stale budget).
 */
function writeCycleBudget(root: string, projectId: Id, cycleId: Id, budget: ReviewBudget, revision: number): void {
  const target = cycleBudgetPath(root, projectId, cycleId)
  mkdirSync(join(root, '.dsh', 'vwa', projectId, 'review-cycles'), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  const bytes = Buffer.from(stableJson({ revision, budget } satisfies CycleBudgetRecord))
  const fd = openSync(tmp, 'w')
  try {
    let written = 0
    while (written < bytes.length) written += writeSync(fd, bytes, written)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, target)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* best effort */ }
    throw error
  }
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
      // §5.1 admission guard, inside the same budget lock as the cycle freeze.
      const projectRefusal = projectAdmissionRefusal(root, projectId, request)
      if (projectRefusal !== undefined) return projectRefusal
      const latest = latestCycle(requests(root, projectId))
      const identity = prior?.cycleId !== undefined
        ? { cycleId: prior.cycleId, cycleSequence: prior.cycleSequence ?? 0 }
        : request.continue === true
          ? latest
          : { cycleId: runId, cycleSequence: latest.cycleSequence + 1 }
      // F3.4: a fresh request opening a cycle freezes its budget into the
      // cycle's sidecar (review-cycles/<cycleId>.json); continuations never
      // re-stamp it. The `budget` field of the request is transport only —
      // it is stripped so request-record write-backs cannot clobber the cycle.
      // F4 consistency check: when the request carries the snapshot revision
      // its budget was computed from, it must still be the CURRENT head at
      // reservation time (inside the lock) — otherwise a budget computed
      // before a concurrent commit would be stamped as the newer revision.
      // The refused admission gets REVISION_CONFLICT (retryable: re-read and
      // reload the budget).
      if (identity.cycleId === runId && request.budget !== undefined) {
        const headRevision = headRevisionOf(root, projectId)
        if (request.budgetRevision !== undefined && request.budgetRevision !== headRevision) {
          return fail(
            'REVISION_CONFLICT',
            `the review budget was computed from revision ${request.budgetRevision} but HEAD is ${headRevision}; reload the budget and retry`,
            true,
          )
        }
        // Stamp the budget's VERIFIED source revision (equal to HEAD here);
        // a revision-0 stamp would let any delayed revision sync cross over
        // onto a NEWER cycle (F3).
        writeCycleBudget(root, projectId, runId, request.budget, request.budgetRevision ?? headRevision)
      }
      const {
        budget: _transport, budgetRevision: _source, projectBudget: _project,
        projectEstimatedCalls: _estimate, ...record
      } = request
      const reserved = { ...record, ...identity, startedAt: prior?.startedAt ?? request.startedAt }
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
  return cycleSpend(requests(root, projectId), excludeRunId, cycleId)
}

/**
 * §5.1: project-cumulative spend across EVERY cycle, read through
 * `loadRequest` (the authoritative reconciled usage ledger — reserved rows of
 * crashed runs count). Not filtered by cycle. `excludeRunId` removes one run
 * (the per-call projection re-adds its own spend explicitly).
 */
export function projectUsage(root: string, projectId: Id, excludeRunId?: Id): CycleUsage {
  return sumUsage(requests(root, projectId).filter((r) => r.runId !== excludeRunId))
}

/** §5.1 admission guard: usage + this request's estimate must fit the project ceiling. */
function projectAdmissionRefusal(root: string, projectId: Id, request: Request): Fail | undefined {
  const limit = request.projectBudget
  if (limit === undefined) return undefined
  const usage = projectUsage(root, projectId)
  const estimate = request.projectEstimatedCalls ?? 0
  const estimatedOutput = estimate * (request.budget?.maxOutputTokensPerCall ?? 0)
  if (
    (limit.maxCalls !== undefined && usage.calls + estimate > limit.maxCalls) ||
    (limit.maxOutputTokens !== undefined && usage.outputTokens + estimatedOutput > limit.maxOutputTokens)
  ) {
    return fail(
      'PROJECT_BUDGET_EXHAUSTED',
      'The project-cumulative review budget is exhausted (all review cycles count). ' +
        'Narrow the review scope, or raise reviewSettings.projectBudget with argument.update op set-review-settings.',
      false,
    )
  }
  return undefined
}

/**
 * Check aggregate spend and persist the caller's reservation in ONE critical
 * section. The callback must synchronously reserve locally and append its
 * durable usage row BEFORE returning. Other runs see that row before they
 * can reserve; a crash after it is written still counts against the cycle.
 *
 * F3.4: the checked budget is the CYCLE's persisted budget (stored on the
 * cycle's lead request record), read inside the same lock — not the caller's
 * snapshot budget. `budget` remains only as the legacy fallback for cycles
 * whose lead request predates the persisted budget (absent budget field).
 */
export function reserveCycleCall(
  root: string, projectId: Id, cycleId: Id, budget: ReviewBudget, inputTokens: number,
  reserve: () => boolean,
  /** §5.1: the project ceiling + the asking run (whose own spend is re-added per call). */
  project?: { budget: ProjectBudget; runId: Id },
): boolean {
  return withBudgetLock(root, projectId, () => {
    const cycleBudget = readCycleBudget(root, projectId, cycleId) ?? budget
    // ONE durable read serves both ledgers inside this lock.
    const all = requests(root, projectId)
    const used = cycleSpend(all, undefined, cycleId)
    if (used.calls + 1 > cycleBudget.maxCallsPerRun ||
        used.inputTokens + inputTokens > cycleBudget.maxInputTokensPerRun ||
        // The output headroom must be checked against the CALLING RUN's actual
        // per-call reservation — its locally frozen budget — never the cycle's
        // (possibly revised) per-call cap: an in-flight run admitted before a
        // downward revision still reserves its old, larger per-call amount.
        used.outputTokens + budget.maxOutputTokensPerCall > cycleBudget.maxOutputTokensPerRun) return false
    if (project !== undefined) {
      const limit = project.budget
      const own = all.find((r) => r.runId === project.runId)
      const others = sumUsage(all.filter((r) => r.runId !== project.runId))
      if (
        (limit.maxCalls !== undefined && others.calls + (own?.calls ?? 0) + 1 > limit.maxCalls) ||
        (limit.maxInputTokens !== undefined &&
          others.inputTokens + (own?.inputTokens ?? 0) + inputTokens > limit.maxInputTokens) ||
        (limit.maxOutputTokens !== undefined &&
          others.outputTokens + (own?.outputTokens ?? 0) + budget.maxOutputTokensPerCall > limit.maxOutputTokens)
      ) return false
    }
    return reserve()
  })
}

/**
 * F3.4: atomically update the LATEST cycle's persisted budget (the sidecar,
 * under the same budget lock — called by the set-review-settings path after
 * the mutation commits). `revision` is the project head revision the budget
 * was computed from: a sync carrying an OLDER revision than the stored one
 * is rejected (false) so a delayed sync cannot overwrite a newer budget —
 * the sync runs after the project transaction released its lock, so two
 * revisions may commit out of sync order. Future admissions in that cycle
 * see the new ceiling; in-flight runs keep their locally frozen
 * `deps.budget`. A caller-visible false must be DISCLOSED (see
 * review-settings-revision.ts), never silently swallowed.
 */
export function updateLatestCycleBudget(
  root: string, projectId: Id, budget: ReviewBudget, revision = 0,
): boolean {
  try {
    return withBudgetLock(root, projectId, () => {
      const store = new ReviewRunStore(root, projectId)
      const { cycleId } = latestCycle(requests(root, projectId))
      if (cycleId === LEGACY_CYCLE) return false
      if (store.readRequest(cycleId) === undefined) return false
      const stored = readCycleBudgetRecordTolerant(root, projectId, cycleId)
      if (stored !== undefined && stored.revision > revision) return false // stale sync
      writeCycleBudget(root, projectId, cycleId, budget, revision)
      return true
    })
  } catch {
    // A failed cycle-budget rewrite must not fail the committed mutation; the
    // revised settings are already in the graph snapshot for new cycles, and
    // the caller discloses the not-yet-applied state (P3).
    return false
  }
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
