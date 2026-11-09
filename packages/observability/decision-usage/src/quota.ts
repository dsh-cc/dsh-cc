/**
 * Durable session quota and transaction lock (design §"Durable quota and
 * concurrency"; BINDING — a verified TLA model backs this module:
 * specs/tla/decision-runtime-quota, deviation = defect).
 *
 * The quota scope is `(projectKey, sessionId)` — one directory holding
 * `usage.jsonl` and the short transaction lock `quota.lock`. Every ledger
 * append (reserve, dispatch, settle, outcome and freeze rows alike) runs
 * inside the same short transaction: acquire → read ledger → check →
 * append+fsync → release; freeze state is read AND computed inside that
 * lock. The lock is `open('wx', 0600)`, retried every 20ms up to 100ms —
 * there is NO lock stealing and NO stale reclaim in v1: a lock left by a
 * crashed process blocks new calls until a human clears it.
 *
 * Recovery: an unpaired reserve keeps its full amount; only a durable
 * not-dispatched refunds; a torn tail or corrupt line freezes the session
 * quota (reasonCode `torn-tail`); a conflicting terminal settle freezes it
 * (reasonCode `quota-frozen`); if persisting a freeze row itself fails the
 * lock file is KEPT in place — the retained reservation plus the stuck lock
 * is the durable blocking mechanism (the `quota-lock-unavailable` outcome).
 *
 * @module @dsh-cc/decision-usage/quota
 */

import { existsSync } from 'node:fs'
import { mkdir, open, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { DecisionBudgetPermit, DecisionBudgetPermitProvider, DecisionLedgerRow } from '@dsh-cc/systemone'
import {
  appendDecisionRow,
  findLease,
  lockFilePath,
  projectDecisionLedger,
  readDecisionLedger,
  usageFilePath,
  type DecisionLedgerProjection,
  type DecisionLedgerReport,
} from './ledger.ts'

/** Lock acquisition: retry every 20ms... */
export const LOCK_RETRY_INTERVAL_MS = 20
/** ...up to 100ms total, then the call fails as `quota-lock-unavailable`. */
export const LOCK_WAIT_BUDGET_MS = 100

/** Session quota limits, read live at every transaction (settings edits never reset spent quota). */
export interface DecisionQuotaLimits {
  maxAttempts: number
  maxInputTokens: number
  maxOutputTokens: number
  ledgerMaxBytes: number
}

/** Why the last reserve/append was turned away (diagnostics surface). */
export type QuotaRejection = 'budget' | 'torn-tail' | 'quota-lock-unavailable' | 'unwritable'

/** Failure codes carried by {@link DecisionQuotaError}. */
export type QuotaFault = QuotaRejection | 'quota-frozen' | 'settle-conflict' | 'orphan-dispatch'

/** A durable-quota failure: never carries row data, only the fixed code. */
export class DecisionQuotaError extends Error {
  readonly code: QuotaFault
  constructor(code: QuotaFault, message: string) {
    super(message)
    this.name = 'DecisionQuotaError'
    this.code = code
  }
}

export interface DecisionQuotaOptions {
  /** The `<dshHome>/decision-usage/<projectKey>/<encodedSessionId>` directory. */
  dir: string
  /** Live limits reader — consulted at every reserve, never cached. */
  limits(): DecisionQuotaLimits
  now?(): number
  uuid?(): string
}

/** Read-only quota/ledger state report for diagnostics and read-only consumers. */
export interface DecisionQuotaReport extends DecisionLedgerProjection {
  tornTail: boolean
  corruptLines: number
  bytes: number
  /** A present lock file blocks every transaction until a human clears it (v1). */
  lockFilePresent: boolean
}

export interface DecisionQuota {
  /** The on-disk directory this quota instance guards. */
  readonly dir: string
  /** The global reserve provider consumed by the decision runner. */
  reserve: DecisionBudgetPermitProvider['reserve']
  /** The locked ledger sink the runner's `append` dep is wired to. */
  append(row: DecisionLedgerRow): Promise<void>
  /** Lock-free read-only report: complete rows, corruption flags, accounting. */
  report(): Promise<DecisionQuotaReport>
  /** Why the most recent reserve was turned away (undefined when it succeeded). */
  lastRejection(): QuotaRejection | undefined
}

/* In-process serialization of all transactions per directory; the file lock
 * additionally excludes other processes. One promise chain per lock path. */
const transactionQueues = new Map<string, Promise<unknown>>()

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = transactionQueues.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  transactionQueues.set(key, run)
  void run.then(
    () => { if (transactionQueues.get(key) === run) transactionQueues.delete(key) },
    () => { if (transactionQueues.get(key) === run) transactionQueues.delete(key) },
  )
  return run
}

/** Abortable sleep; resolves false when the signal fired first. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * `open('wx', 0600)` with the binding retry protocol: EEXIST retries every
 * 20ms up to 100ms total; any other error or exhaustion fails. NO lock
 * stealing, NO stale reclaim — a held lock only ever waits.
 */
async function acquireQuotaLock(lockPath: string, signal: AbortSignal | undefined): Promise<FileHandle | undefined> {
  const started = Date.now()
  for (;;) {
    if (signal?.aborted === true) return undefined
    try {
      return await open(lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined
      if (Date.now() - started >= LOCK_WAIT_BUDGET_MS) return undefined
      if (!(await delay(LOCK_RETRY_INTERVAL_MS, signal))) return undefined
    }
  }
}

interface LockControl {
  /** Set by the freeze-persist-failure path: keep the lock file in place. */
  keep: boolean
}

/** A transaction outcome; `unavailable` means the lock was never acquired (the body never ran). */
type TxnOutcome<T> = { readonly acquired: true; readonly value: T } | { readonly acquired: false }

/**
 * One acquire → body → release transaction. `{acquired:false}` when the lock
 * could not be acquired (callers map to their failure path). The body
 * receives the {@link LockControl}: setting `keep` retains the lock file —
 * the design's freeze-persist-failure blocking mechanism.
 */
async function transact<T>(
  dir: string,
  signal: AbortSignal | undefined,
  body: (lock: LockControl) => Promise<T>,
): Promise<TxnOutcome<T>> {
  const lockPath = lockFilePath(dir)
  await mkdir(dir, { recursive: true })
  const handle = await acquireQuotaLock(lockPath, signal)
  if (handle === undefined) return { acquired: false }
  const control: LockControl = { keep: false }
  try {
    return { acquired: true, value: await body(control) }
  } finally {
    try {
      await handle.close()
    } finally {
      if (!control.keep) await unlink(lockPath).catch(() => { /* a stuck lock is itself the alarm */ })
    }
  }
}

const TERMINAL_OUTCOMES = new Set(['actual', 'unknown', 'not-dispatched'])

interface LoadedLedger {
  report: DecisionLedgerReport
  projection: DecisionLedgerProjection
}

async function loadLedger(file: string): Promise<LoadedLedger | undefined> {
  try {
    const report = await readDecisionLedger(file)
    return { report, projection: projectDecisionLedger(report.rows) }
  } catch {
    return undefined
  }
}

/** Torn = crash-torn tail line or any non-conforming line (never silently skipped). */
const isTorn = (report: DecisionLedgerReport): boolean => report.tornTail || report.corruptLines.length > 0

type ReserveInput = Parameters<DecisionBudgetPermitProvider['reserve']>[0]

/** The shared row context available to quota-written rows (narrow, privacy-clean). */
interface NarrowBase {
  decisionId: string
  attempt: number
  scope: DecisionLedgerRow['scope']
  feature: DecisionLedgerRow['feature']
}

const narrowOfInput = (input: ReserveInput): NarrowBase => ({
  decisionId: input.decisionId,
  attempt: input.attempt,
  scope: { ...input.scope },
  feature: input.feature,
})

const narrowOfRow = (row: DecisionLedgerRow): NarrowBase => ({
  decisionId: row.decisionId,
  attempt: row.attempt,
  scope: { ...row.scope },
  feature: row.feature,
})

/**
 * The quota reserve row. provider/model/revision/mode are unknown at this
 * layer by contract design (the reserve input carries none of them), so the
 * row is accounting-canonical ('' for unavailable fields, mode 'active'):
 * route attribution lives on the runner-written dispatch/outcome rows of the
 * same lease. Reserved bounds are the lease's accounting values.
 */
function narrowReserveRow(input: ReserveInput, now: () => number, uuid: () => string): DecisionLedgerRow {
  return {
    schemaVersion: 1,
    eventId: uuid(),
    decisionId: input.decisionId,
    attempt: input.attempt,
    phase: 'reserve',
    time: now(),
    scope: { ...input.scope },
    feature: input.feature,
    mode: 'active',
    provider: '',
    requestedModel: '',
    actualModel: null,
    routeRevision: '',
    questionVersion: '',
    policyVersion: '',
    inputHash: '',
    reservedInputTokens: input.inputTokens,
    reservedOutputTokens: input.outputTokens,
    latencyMs: 0,
    outcome: 'reserved',
  }
}

/** A freeze marker persisted inside the transaction that computed the freeze. */
function freezeRow(
  base: NarrowBase,
  source: DecisionLedgerRow | undefined,
  reasonCode: 'quota-frozen' | 'torn-tail',
  now: () => number,
  uuid: () => string,
): DecisionLedgerRow {
  return {
    schemaVersion: 1,
    eventId: uuid(),
    decisionId: base.decisionId,
    attempt: base.attempt,
    phase: 'outcome',
    time: now(),
    scope: base.scope,
    feature: base.feature,
    mode: source?.mode ?? 'active',
    provider: source?.provider ?? '',
    requestedModel: source?.requestedModel ?? '',
    actualModel: null,
    routeRevision: source?.routeRevision ?? '',
    questionVersion: source?.questionVersion ?? '',
    policyVersion: source?.policyVersion ?? '',
    inputHash: source?.inputHash ?? '',
    latencyMs: 0,
    outcome: 'budget',
    reasonCode,
  }
}

/**
 * Persist a freeze row inside the current transaction. On append failure the
 * lock file is KEPT in place (the durable blocking mechanism) and the error
 * propagates; callers map it per their contract.
 */
async function persistFreeze(
  lock: LockControl,
  file: string,
  row: DecisionLedgerRow,
): Promise<void> {
  try {
    await appendDecisionRow(file, row)
  } catch (error) {
    lock.keep = true
    throw error
  }
}

/** Terminal-state compatibility between a durable settle row and a new settle. */
const settleMatches = (
  existing: { outcome: string; actualInputTokens?: number | undefined; actualOutputTokens?: number | undefined },
  outcome: { kind: string; usage?: { input_tokens: number; output_tokens: number } },
): boolean => {
  if (existing.outcome !== outcome.kind) return false
  if (outcome.kind !== 'actual' || outcome.usage === undefined) return true
  return existing.actualInputTokens === outcome.usage.input_tokens
    && existing.actualOutputTokens === outcome.usage.output_tokens
}

/** The durable terminal settle rows of one lease (first-wins charges). */
function terminalSettles(rows: readonly DecisionLedgerRow[], decisionId: string, attempt: number): DecisionLedgerRow[] {
  return findLease(rows, decisionId, attempt, 'settle').filter((r) => TERMINAL_OUTCOMES.has(r.outcome))
}

/** Create the durable quota guarding one (projectKey, sessionId) directory. */
export function createDecisionQuota(options: DecisionQuotaOptions): DecisionQuota {
  const now = options.now ?? (() => Date.now())
  const uuid = options.uuid ?? (() => randomUUID())
  const dir = options.dir
  const file = usageFilePath(dir)
  let lastRejection: QuotaRejection | undefined

  const reserve: DecisionBudgetPermitProvider['reserve'] = async (input) => {
    let permit: DecisionBudgetPermit | undefined
    const txn = await enqueue(dir, () =>
      transact(dir, input.signal, async (lock) => {
        const state = await loadLedger(file)
        if (state === undefined) {
          lastRejection = 'unwritable'
          return false
        }
        if (isTorn(state.report)) {
          // A torn ledger is never adopted: persist the freeze inside this
          // same transaction, then reject as budget (design recovery rule).
          if (state.projection.freezeReasonCode !== 'torn-tail') {
            await persistFreeze(lock, file, freezeRow(narrowOfInput(input), undefined, 'torn-tail', now, uuid))
          }
          lastRejection = 'torn-tail'
          return false
        }
        const { projection } = state
        const limits = options.limits()
        const reject = (): false => {
          lastRejection = 'budget'
          return false
        }
        if (projection.frozen) return reject()
        if (state.report.bytes >= limits.ledgerMaxBytes) return reject()
        if (projection.attemptsUsed >= limits.maxAttempts) return reject()
        if (projection.retainedInputTokens + input.inputTokens > limits.maxInputTokens) return reject()
        if (projection.retainedOutputTokens + input.outputTokens > limits.maxOutputTokens) return reject()
        // leaseId = decisionId + attempt: a durable reserve row for this lease
        // means the reservation already exists (dedup across retry/crash).
        const exists = findLease(state.report.rows, input.decisionId, input.attempt, 'reserve').length > 0
        if (!exists) await appendDecisionRow(file, narrowReserveRow(input, now, uuid))
        permit = {
          async settle(outcome) {
            await settleLease(input, outcome)
          },
        }
        return true
      }),
    )
    if (!txn.acquired) lastRejection = 'quota-lock-unavailable'
    return txn.acquired && txn.value === true ? permit : undefined
  }

  /**
   * The permit settle callback, inside its own short transaction: torn
   * recovery freeze first, then single-invocation enforcement against the
   * durable settle rows of this lease — an identical repeat is a no-op, a
   * CONFLICTING terminal persists the `quota-frozen` freeze row and throws.
   * The runner's own settle row lands next through {@link append}, which
   * re-validates atomically (check-then-append is one critical section).
   */
  async function settleLease(input: ReserveInput, outcome: Parameters<DecisionBudgetPermit['settle']>[0]): Promise<void> {
    const txn = await enqueue(dir, () =>
      transact(dir, undefined, async (lock) => {
        const state = await loadLedger(file)
        if (state === undefined) throw new DecisionQuotaError('unwritable', 'decision-usage: ledger unreadable during settle')
        if (isTorn(state.report)) {
          if (state.projection.freezeReasonCode !== 'torn-tail') {
            await persistFreeze(lock, file, freezeRow(narrowOfInput(input), undefined, 'torn-tail', now, uuid))
          }
          return
        }
        for (const existing of terminalSettles(state.report.rows, input.decisionId, input.attempt)) {
          const candidate = outcome.kind === 'actual'
            ? { kind: outcome.kind, usage: outcome.usage }
            : { kind: outcome.kind }
          if (!settleMatches(existing, candidate)) {
            await persistFreeze(lock, file, freezeRow(narrowOfInput(input), undefined, 'quota-frozen', now, uuid))
            throw new DecisionQuotaError('settle-conflict', 'decision-usage: conflicting terminal settle')
          }
        }
      }),
    )
    if (!txn.acquired) throw new DecisionQuotaError('quota-lock-unavailable', 'decision-usage: settle could not acquire quota.lock')
  }

  /**
   * The locked append for every runner-written row. Reserve/dispatch (spend)
   * rows are refused when the ledger is torn or frozen; settle rows are
   * idempotent (an identical durable repeat charges nothing more) and a
   * conflicting terminal appends the freeze row then throws; outcome rows
   * always land (reporting, incl. the accounting-overrun freeze marker).
   */
  async function append(row: DecisionLedgerRow): Promise<void> {
    const txn = await enqueue(dir, () =>
      transact(dir, undefined, async (lock) => {
        const state = await loadLedger(file)
        if (state === undefined) throw new DecisionQuotaError('unwritable', 'decision-usage: ledger unreadable during append')
        const torn = isTorn(state.report)
        if (torn && state.projection.freezeReasonCode !== 'torn-tail') {
          await persistFreeze(lock, file, freezeRow(narrowOfRow(row), row, 'torn-tail', now, uuid))
        }
        const { projection } = state
        const spendBlocked = torn || projection.frozen
        if (row.phase === 'reserve') {
          if (findLease(state.report.rows, row.decisionId, row.attempt, 'reserve').length > 0) return
          if (spendBlocked) throw new DecisionQuotaError(torn ? 'torn-tail' : 'quota-frozen', 'decision-usage: reserve after freeze')
          const limits = options.limits()
          const rin = row.reservedInputTokens ?? 0
          const rout = row.reservedOutputTokens ?? 0
          if (
            projection.attemptsUsed >= limits.maxAttempts
            || projection.retainedInputTokens + rin > limits.maxInputTokens
            || projection.retainedOutputTokens + rout > limits.maxOutputTokens
            || state.report.bytes >= limits.ledgerMaxBytes
          ) {
            throw new DecisionQuotaError('budget', 'decision-usage: reserve row exceeds session limits')
          }
        } else if (row.phase === 'dispatch') {
          if (findLease(state.report.rows, row.decisionId, row.attempt, 'dispatch').length > 0) return
          if (spendBlocked) throw new DecisionQuotaError(torn ? 'torn-tail' : 'quota-frozen', 'decision-usage: dispatch after freeze')
          if (findLease(state.report.rows, row.decisionId, row.attempt, 'reserve').length === 0) {
            throw new DecisionQuotaError('orphan-dispatch', 'decision-usage: dispatch without durable reserve')
          }
        } else if (row.phase === 'settle') {
          const settles = terminalSettles(state.report.rows, row.decisionId, row.attempt)
          for (const existing of settles) {
            const candidate = row.outcome === 'actual'
              ? { kind: row.outcome, usage: { input_tokens: row.actualInputTokens ?? -1, output_tokens: row.actualOutputTokens ?? -1 } }
              : { kind: row.outcome }
            if (!settleMatches(existing, candidate)) {
              await persistFreeze(lock, file, freezeRow(narrowOfRow(row), row, 'quota-frozen', now, uuid))
              throw new DecisionQuotaError('settle-conflict', 'decision-usage: conflicting terminal settle row')
            }
          }
          if (settles.length > 0) return // idempotent repeat: charges nothing more
        }
        // outcome rows (and bookkeeping settles after a freeze) always land.
        await appendDecisionRow(file, row)
      }),
    )
    if (!txn.acquired) throw new DecisionQuotaError('quota-lock-unavailable', 'decision-usage: append could not acquire quota.lock')
  }

  async function report(): Promise<DecisionQuotaReport> {
    const state = await loadLedger(file)
    if (state === undefined) throw new DecisionQuotaError('unwritable', 'decision-usage: ledger unreadable for report')
    return {
      ...state.projection,
      tornTail: state.report.tornTail,
      corruptLines: state.report.corruptLines.length,
      bytes: state.report.bytes,
      lockFilePresent: existsSync(lockFilePath(dir)),
    }
  }

  return {
    dir,
    reserve,
    append,
    report,
    lastRejection: () => lastRejection,
  }
}
