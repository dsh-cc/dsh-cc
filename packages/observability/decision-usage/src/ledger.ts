/**
 * Durable JSONL usage ledger for SystemOne decisions (design
 * §"Durable quota and concurrency", §"Ledger, privacy and reporting").
 *
 * Layout: `<dshHome>/decision-usage/<projectKey>/<encodeSegment(sessionId)>/`
 * holding `usage.jsonl` and the transaction lock `quota.lock`. This module
 * owns path construction, the fsync-capable append (open/write/fsync/close —
 * NEVER appendFile), the torn-tail-detecting reader (a truncated or
 * non-JSON-conforming line is REPORTED, never silently skipped), and the
 * read-only accounting projection both the quota module and `/cost` consume.
 *
 * @module @dsh-cc/decision-usage/ledger
 */

import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { encodeSegment } from '@dsh-cc/sidecar-io'
import type { DecisionLedgerReasonCode, DecisionLedgerRow } from '@dsh-cc/systemone'

/** Sidecar directory name under dshHome. */
export const LEDGER_DIR_NAME = 'decision-usage'
/** The usage ledger file inside one (projectKey, sessionId) directory. */
export const USAGE_FILE_NAME = 'usage.jsonl'
/** The short transaction lock file inside the same directory. */
export const LOCK_FILE_NAME = 'quota.lock'

/** `<home>/decision-usage/<projectKey>/<encodedSessionId>` — never concatenates raw ids. */
export function decisionUsageDir(home: string, projectKey: string, sessionId: string): string {
  return join(home, LEDGER_DIR_NAME, projectKey, encodeSegment(sessionId))
}

/** The usage.jsonl path inside one decision-usage directory. */
export function usageFilePath(dir: string): string {
  return join(dir, USAGE_FILE_NAME)
}

/** The quota.lock path inside one decision-usage directory. */
export function lockFilePath(dir: string): string {
  return join(dir, LOCK_FILE_NAME)
}

const PHASES = new Set(['reserve', 'dispatch', 'settle', 'outcome'])
const OUTCOMES = new Set([
  'reserved', 'dispatched', 'actual', 'unknown', 'not-dispatched', 'answered',
  'unconfigured', 'budget', 'timeout', 'cancelled', 'malformed', 'error',
])
const REASON_CODES = new Set([
  'model-version-mismatch', 'accounting-overrun', 'quota-frozen',
  'quota-lock-unavailable', 'torn-tail',
])

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isSafeNatural = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isFiniteTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const shapedTokens = (row: Record<string, unknown>, key: string, required: boolean): boolean => {
  const value = row[key]
  if (value === undefined) return !required
  return isSafeNatural(value)
}

/**
 * Structural schemaVersion=1 guard. A line that parses as JSON but does not
 * satisfy the schema is corruption, not a row (readers report it corrupt;
 * the quota treats it as a torn ledger). Unknown EXTRA keys are tolerated.
 */
export function isDecisionLedgerRow(value: unknown): value is DecisionLedgerRow {
  if (!isPlainObject(value)) return false
  if (value.schemaVersion !== 1) return false
  if (!isNonEmptyString(value.eventId) || !isNonEmptyString(value.decisionId)) return false
  if (!isSafeNatural(value.attempt)) return false
  if (typeof value.phase !== 'string' || !PHASES.has(value.phase)) return false
  if (!isFiniteTime(value.time) || !isFiniteTime(value.latencyMs)) return false
  const scope = value.scope
  if (!isPlainObject(scope)) return false
  if (!isNonEmptyString(scope.projectKey) || !isNonEmptyString(scope.sessionId)) return false
  if (!isNonEmptyString(scope.agentId) || !isSafeNatural(scope.originSeq)) return false
  if (!isNonEmptyString(value.feature)) return false
  if (value.mode !== 'shadow' && value.mode !== 'active') return false
  if (typeof value.provider !== 'string') return false
  if (typeof value.requestedModel !== 'string') return false
  if (value.actualModel !== null && typeof value.actualModel !== 'string') return false
  if (typeof value.routeRevision !== 'string') return false
  if (typeof value.questionVersion !== 'string' || typeof value.policyVersion !== 'string') return false
  if (typeof value.inputHash !== 'string') return false
  if (typeof value.outcome !== 'string' || !OUTCOMES.has(value.outcome)) return false
  if (value.reasonCode !== undefined && (typeof value.reasonCode !== 'string' || !REASON_CODES.has(value.reasonCode))) return false
  const phase = value.phase
  const outcome = value.outcome
  if (!shapedTokens(value, 'reservedInputTokens', phase === 'reserve' || phase === 'settle')) return false
  if (!shapedTokens(value, 'reservedOutputTokens', phase === 'reserve' || phase === 'settle')) return false
  if (!shapedTokens(value, 'actualInputTokens', outcome === 'actual')) return false
  if (!shapedTokens(value, 'actualOutputTokens', outcome === 'actual')) return false
  return true
}

/**
 * Append one row durably: open('a+', 0600) → optional torn-tail newline
 * repair → write → fsync → close. Throws on any failure — callers (the
 * quota transaction) translate. The repair byte runs inside the caller's
 * lock, so a torn fragment is terminated, never spliced with the new row.
 */
export async function appendDecisionRow(filePath: string, row: DecisionLedgerRow): Promise<void> {
  await mkdir(join(filePath, '..'), { recursive: true })
  const handle = await open(filePath, 'a+', 0o600)
  try {
    const line = `${JSON.stringify(row)}\n`
    let content = line
    const info = await handle.stat()
    if (info.size > 0) {
      const tail = Buffer.alloc(1)
      const read = await handle.read(tail, 0, 1, info.size - 1)
      if (read.bytesRead === 1 && tail[0] !== 0x0a) content = `\n${line}`
    }
    await handle.write(Buffer.from(content, 'utf8'))
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Read-only report over one ledger file; missing file reads as empty. */
export interface DecisionLedgerReport {
  /** Complete, schema-valid rows in file order (dedup/attribution is the projection's job). */
  rows: DecisionLedgerRow[]
  /** The file's final non-blank line lacks a trailing newline (crash mid-append). */
  tornTail: boolean
  /** 1-based line numbers of non-blank lines that are not valid schemaVersion=1 rows. */
  corruptLines: number[]
  /** File size in bytes (0 when absent). */
  bytes: number
}

/**
 * Read a ledger, skipping blank lines but DETECTING corruption: a torn tail
 * (no trailing newline) and every non-conforming line are reported. Never
 * throws; a missing/unreadable file yields an empty report. Callers decide:
 * the quota freezes on `tornTail || corruptLines.length > 0`; read-only
 * reporters may show `rows` and flag the ledger corrupt.
 */
export async function readDecisionLedger(filePath: string): Promise<DecisionLedgerReport> {
  const empty: DecisionLedgerReport = { rows: [], tornTail: false, corruptLines: [], bytes: 0 }
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    // Absent is a fresh session; anything else (EACCES, EISDIR, ...) must NOT
    // pose as an empty ledger — hidden rows would read as fresh quota.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty
    throw error
  }
  const report: DecisionLedgerReport = {
    rows: [],
    tornTail: raw.length > 0 && !raw.endsWith('\n'),
    corruptLines: [],
    bytes: Buffer.byteLength(raw, 'utf8'),
  }
  const lines = raw.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line === undefined || line.trim().length === 0) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isDecisionLedgerRow(parsed)) report.rows.push(parsed)
      else report.corruptLines.push(index + 1)
    } catch {
      report.corruptLines.push(index + 1)
    }
  }
  return report
}

/** The reason codes that durably freeze a session quota once recorded in the ledger. */
export type DecisionLedgerFreezeCode = Extract<DecisionLedgerReasonCode, 'quota-frozen' | 'torn-tail' | 'accounting-overrun'>

/** Freeze-marker reason codes (model-version-mismatch charges but never freezes). */
export const LEDGER_FREEZE_REASON_CODES: readonly DecisionLedgerFreezeCode[] = [
  'quota-frozen',
  'torn-tail',
  'accounting-overrun',
]

/** One attempt-lease accounting view (design's derived accounting; TLA RetInK/RetOutK). */
export interface DecisionLeaseProjection {
  decisionId: string
  attempt: number
  reservedInputTokens: number
  reservedOutputTokens: number
  dispatched: boolean
  settledKind: 'actual' | 'unknown' | 'not-dispatched' | undefined
  actualInputTokens: number | undefined
  actualOutputTokens: number | undefined
  /** Retained after recovery semantics: actual → actuals, unknown/unsettled → full, refunded → 0. */
  retainedInputTokens: number
  retainedOutputTokens: number
  /** max-attempts-per-session counts reserved attempts that were not durably refunded. */
  countedAsAttempt: boolean
  provider: string | undefined
  requestedModel: string | undefined
  actualModel: string | null | undefined
}

/** Whole-ledger accounting projection (one quota window). */
export interface DecisionLedgerProjection {
  attemptsUsed: number
  retainedInputTokens: number
  retainedOutputTokens: number
  frozen: boolean
  freezeReasonCode: DecisionLedgerFreezeCode | undefined
  /** First-settle-wins per lease; count of dropped later conflicting settle rows (freeze marks them too). */
  conflictingSettles: number
  leases: readonly DecisionLeaseProjection[]
}

const SETTLE_KINDS = new Set(['actual', 'unknown', 'not-dispatched'])

/**
 * Derive the accounting projection from complete ledger rows. Recovery rules
 * (design REQ-4/5): an unpaired reserve keeps its full amount; only a durable
 * not-dispatched refunds; a settle is idempotent — the FIRST terminal row per
 * (decisionId, attempt) charges; later conflicting rows change nothing (the
 * freeze they provoked is read back via freeze markers).
 */
export function projectDecisionLedger(rows: readonly DecisionLedgerRow[]): DecisionLedgerProjection {
  type MutableLease = {
    -readonly [K in keyof DecisionLeaseProjection]: DecisionLeaseProjection[K]
  }
  const byLease = new Map<string, MutableLease>()
  let frozen = false
  let freezeReasonCode: DecisionLedgerFreezeCode | undefined
  let conflictingSettles = 0

  const leaseOf = (row: DecisionLedgerRow): MutableLease => {
    const key = `${row.decisionId}|${row.attempt}`
    let lease = byLease.get(key)
    if (lease === undefined) {
      lease = {
        decisionId: row.decisionId,
        attempt: row.attempt,
        reservedInputTokens: 0,
        reservedOutputTokens: 0,
        dispatched: false,
        settledKind: undefined,
        actualInputTokens: undefined,
        actualOutputTokens: undefined,
        retainedInputTokens: 0,
        retainedOutputTokens: 0,
        countedAsAttempt: false,
        provider: undefined,
        requestedModel: undefined,
        actualModel: undefined,
      }
      byLease.set(key, lease)
    }
    return lease
  }

  for (const row of rows) {
    // Freeze markers: first marker wins; model-version-mismatch never freezes.
    if (row.reasonCode !== undefined && (LEDGER_FREEZE_REASON_CODES as readonly string[]).includes(row.reasonCode)) {
      if (!frozen) {
        frozen = true
        freezeReasonCode = row.reasonCode as DecisionLedgerFreezeCode
      }
    }
    const lease = leaseOf(row)
    if (lease.provider === undefined && row.provider.length > 0) lease.provider = row.provider
    if (lease.requestedModel === undefined && row.requestedModel.length > 0) lease.requestedModel = row.requestedModel
    if (lease.actualModel === undefined && row.actualModel !== null) lease.actualModel = row.actualModel
    if (row.phase === 'reserve') {
      // Same lease reserves agree on bounds by construction; first row stands.
      if (lease.reservedInputTokens === 0 && lease.reservedOutputTokens === 0) {
        lease.reservedInputTokens = row.reservedInputTokens ?? 0
        lease.reservedOutputTokens = row.reservedOutputTokens ?? 0
        lease.countedAsAttempt = true
        lease.retainedInputTokens = lease.reservedInputTokens
        lease.retainedOutputTokens = lease.reservedOutputTokens
      }
    } else if (row.phase === 'dispatch') {
      lease.dispatched = true
    } else if (row.phase === 'settle' && SETTLE_KINDS.has(row.outcome)) {
      if (lease.settledKind === undefined) {
        lease.settledKind = row.outcome as 'actual' | 'unknown' | 'not-dispatched'
        if (row.outcome === 'actual') {
          lease.actualInputTokens = row.actualInputTokens ?? 0
          lease.actualOutputTokens = row.actualOutputTokens ?? 0
          lease.retainedInputTokens = lease.actualInputTokens
          lease.retainedOutputTokens = lease.actualOutputTokens
        } else if (row.outcome === 'not-dispatched') {
          lease.retainedInputTokens = 0
          lease.retainedOutputTokens = 0
          lease.countedAsAttempt = false
        } else {
          lease.retainedInputTokens = lease.reservedInputTokens
          lease.retainedOutputTokens = lease.reservedOutputTokens
          lease.actualInputTokens = lease.reservedInputTokens
          lease.actualOutputTokens = lease.reservedOutputTokens
        }
      } else {
        // A later settle row for the same lease: idempotent repeat or a
        // conflict (its freeze row is read back separately) — never re-charge.
        const sameKind = lease.settledKind === row.outcome
        const sameActuals = row.outcome !== 'actual'
          || (lease.actualInputTokens === (row.actualInputTokens ?? -1)
            && lease.actualOutputTokens === (row.actualOutputTokens ?? -1))
        if (!(sameKind && sameActuals)) conflictingSettles += 1
      }
    }
  }

  let attemptsUsed = 0
  let retainedInputTokens = 0
  let retainedOutputTokens = 0
  const leases: DecisionLeaseProjection[] = []
  for (const lease of byLease.values()) {
    if (lease.reservedInputTokens === 0 && lease.reservedOutputTokens === 0 && !lease.dispatched) {
      // Settle/outcome-only ghost (no reserve row visible): no accounting mass,
      // but keep it listed for diagnostics.
      lease.countedAsAttempt = false
      lease.retainedInputTokens = 0
      lease.retainedOutputTokens = 0
    } else {
      if (lease.countedAsAttempt) attemptsUsed += 1
      retainedInputTokens += lease.retainedInputTokens
      retainedOutputTokens += lease.retainedOutputTokens
    }
    leases.push(lease)
  }
  return {
    attemptsUsed,
    retainedInputTokens,
    retainedOutputTokens,
    frozen,
    freezeReasonCode,
    conflictingSettles,
    leases,
  }
}

/** Lease lookup helper for quota checks: the lease row identity is decisionId + attempt. */
export function findLease(
  rows: readonly DecisionLedgerRow[],
  decisionId: string,
  attempt: number,
  phase: DecisionLedgerRow['phase'],
): DecisionLedgerRow[] {
  return rows.filter((r) => r.decisionId === decisionId && r.attempt === attempt && r.phase === phase)
}
