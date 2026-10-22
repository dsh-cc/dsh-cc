/**
 * Review-run persistence, cache, and disagreement detection (design
 * docs/plans/2026-10-16-vwa-evidence-argument.md §11.3, §14.1, §14.3).
 *
 * Review writes are serialized separately from author transactions and never
 * increment the graph revision (§14.3): each record is written temp + fsync +
 * rename, then read back and hash-verified. The usage ledger is append-only.
 * Run status moves queued→running→completed/incomplete/cancelled/
 * budget-exhausted; a persisted `running` found at load becomes `incomplete`
 * (restart rule, §14.3) and continuing requires a NEW requestId.
 *
 * Cache key (§11.3): SHA256(stableJson({stage,targetRefs,dependencyDigest,
 * contractHash,policyHash,reviewerConfigHash,promptHash})). Only completed,
 * schema-valid records containing ALL required checks are reusable.
 *
 * @module @dsh-cc/vwa-argument/review-run-store
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { sha256Hex, stableJson, validateReviewResponse } from './schema.ts'
import type { Finding, Hash, Id, ReviewJobStatus, ReviewRecord, ReviewResponse } from './types.ts'

/** One usage-ledger row (§14.1 usage.jsonl). */
export interface UsageRow {
  runId: Id
  taskId: string
  seq: number
  kind: 'actual' | 'reserved' | 'reused' | 'repair' | 'error'
  inputTokens: number
  outputTokens: number
  method: 'tokenizer' | 'bytes-upper-bound'
  /** B.2.4: on retry rows, `${taskId}:${seq}` of the original attempt. */
  retryOf?: string
}

/** Disk layout handle for one project's review runs (§14.1). */
const PROCESS_NONCE = randomUUID()

export class ReviewRunStore {
  private readonly base: string

  constructor(root: string, projectId: string) {
    this.base = join(root, '.dsh', 'vwa', projectId, 'review-runs')
  }

  runDir(runId: string): string {
    return join(this.base, runId)
  }

  /** Create the run directory skeleton. */
  initRun(runId: string): string {
    mkdirSync(join(this.runDir(runId), 'records'), { recursive: true })
    return this.runDir(runId)
  }

  writeRequest(
    runId: string,
    request: {
      schemaVersion: 1
      requestId: string
      runId: Id
      stage: string
      targetClaimIds: Id[]
      artifactId?: Id
      payloadHash?: Hash
      /** §A.4: a continue request draws on its review cycle's budget (review-cycle.ts). */
      continue?: boolean
      /** F1.4: admission-time retry pool (extra attempts across the whole run); absent = legacy unlimited. */
      retryAllowance?: number
      /** Stable admission-time identity; absent only on legacy requests. */
      cycleId?: Id
      cycleSequence?: number
      /**
       * F3.4 transport-only: admission-time cycle budget, consumed by
       * reserveCycleRequest and STRIPPED before this record persists — the
       * cycle's authoritative budget lives in the review-cycles sidecar
       * (review-cycle.ts), which request write-backs can never clobber.
       */
      budget?: import('./review-budget.ts').ReviewBudget
      /**
       * F4 transport-only: the project head revision the `budget` was computed
       * from; reserveCycleRequest verifies it against the current HEAD inside
       * the budget lock and refuses with REVISION_CONFLICT on mismatch.
       */
      budgetRevision?: number
      taskId?: string
      processId?: number
      processNonce?: string
      status: ReviewJobStatus
      inputTokens: number
      outputTokens: number
      calls: number
      startedAt: string
      endedAt?: string
    },
  ): void {
    this.writeAtomic(join(this.runDir(runId), 'request.json'), request)
  }

  readRequest(runId: string): Parameters<ReviewRunStore['writeRequest']>[1] | undefined {
    return this.readJson(join(this.runDir(runId), 'request.json')) as
      | Parameters<ReviewRunStore['writeRequest']>[1]
      | undefined
  }

  /** Persist a reservation before the host can schedule the callback. */
  reserveRequest(runId: string, request: Parameters<ReviewRunStore['writeRequest']>[1]): void {
    this.initRun(runId)
    this.writeRequest(runId, { ...request, processId: process.pid, processNonce: PROCESS_NONCE })
  }

  /** §14.3 restart rule: a persisted `running` run becomes `incomplete` on load. */
  loadRequest(runId: string): Parameters<ReviewRunStore['writeRequest']>[1] | undefined {
    let request = this.readRequest(runId)
    if (request) {
      const usage = this.readUsage(runId)
      const attempts = new Map<string, UsageRow>()
      for (const row of usage)
        if (row.kind !== 'reused' && (row.inputTokens > 0 || row.outputTokens > 0))
          attempts.set(`${row.taskId}:${row.seq}`, row)
      request = {
        ...request,
        calls: Math.max(request.calls, attempts.size),
        inputTokens: Math.max(
          request.inputTokens,
          [...attempts.values()].reduce((n, r) => n + r.inputTokens, 0),
        ),
        outputTokens: Math.max(
          request.outputTokens,
          [...attempts.values()].reduce((n, r) => n + r.outputTokens, 0),
        ),
      }
    }
    if (request?.status === 'running' || request?.status === 'queued') {
      let alive = request.processId === process.pid && request.processNonce === PROCESS_NONCE
      if (request.processId !== undefined && request.processId !== process.pid) {
        try {
          process.kill(request.processId, 0)
          alive = true
        } catch {
          alive = false
        }
      }
      if (!alive) return { ...request, status: 'incomplete' }
    }
    return request
  }

  /** Locate an existing run by requestId (§10.6: same requestId never re-calls the model). */
  findRunByRequestId(requestId: string): Parameters<ReviewRunStore['writeRequest']>[1] | undefined {
    if (!existsSync(this.base)) return undefined
    for (const runId of readdirSync(this.base)) {
      const request = this.loadRequest(runId)
      if (request?.requestId === requestId) return request
    }
    return undefined
  }

  /** §14.3 record write: temp + fsync + rename, then read-back hash verification. */
  writeRecord(runId: string, record: ReviewRecord & { kind?: 'disagreement' }): { ok: true; recordHash: Hash } {
    const recordHash = sha256Hex(stableJson(record))
    const path = join(this.runDir(runId), 'records', `${record.runId}_${randomUUID()}.json`)
    this.writeAtomic(path, { recordHash, record })
    const stored = this.readJson(path) as { recordHash?: string; record?: unknown } | undefined
    if (stored?.recordHash !== recordHash || sha256Hex(stableJson(stored.record)) !== recordHash)
      throw new Error('review record read-back failed')
    return { ok: true, recordHash }
  }

  readRecords(runId: string): (ReviewRecord & { kind?: 'disagreement' })[] {
    const dir = join(this.runDir(runId), 'records')
    if (!existsSync(dir)) return []
    const out: (ReviewRecord & { kind?: 'disagreement' })[] = []
    for (const file of readdirSync(dir)) {
      const parsed = this.readJson(join(dir, file)) as
        | { recordHash?: Hash; record?: ReviewRecord & { kind?: 'disagreement' } }
        | undefined
      if (parsed?.record === undefined) continue
      // §14.2: hash-mismatched records never enter current.
      if (sha256Hex(stableJson(parsed.record)) !== parsed.recordHash) continue
      out.push(parsed.record)
    }
    return out
  }

  writeOutcome(runId: string, outcome: unknown): void {
    this.writeAtomic(join(this.runDir(runId), 'outcome.json'), { hash: sha256Hex(stableJson(outcome)), outcome })
  }
  readOutcome(runId: string): unknown {
    const stored = this.readJson(join(this.runDir(runId), 'outcome.json')) as
      | { hash?: string; outcome?: unknown }
      | undefined
    return stored?.outcome !== undefined && sha256Hex(stableJson(stored.outcome)) === stored.hash
      ? stored.outcome
      : undefined
  }

  readUsage(runId: string): UsageRow[] {
    try {
      return readFileSync(join(this.runDir(runId), 'usage.jsonl'), 'utf8')
        .split('\n')
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as UsageRow]
          } catch {
            return []
          }
        })
    } catch {
      return []
    }
  }

  appendUsage(runId: string, row: UsageRow): void {
    mkdirSync(this.runDir(runId), { recursive: true })
    const line = stableJson(row)
    const fd = openSync(join(this.runDir(runId), 'usage.jsonl'), 'a')
    try {
      writeSync(fd, `${line}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  private writeAtomic(path: string, value: unknown): void {
    mkdirSync(join(path, '..'), { recursive: true })
    const tmp = `${path}.tmp`
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, stableJson(value))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  }

  private readJson(path: string): unknown {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return undefined
    }
  }
}

/** §11.3 cache key. */
export function cacheKey(input: {
  stage: string
  targetRefs: { id: Id; entityVersion: number }[]
  requiredRules: { targetId: Id; ruleId: string }[]
  dependencyDigest: Hash
  contractHash: Hash
  policyHash: Hash
  reviewerConfigHash: Hash
  promptHash: Hash
}): Hash {
  return sha256Hex(
    stableJson({
      stage: input.stage,
      targetRefs: input.targetRefs,
      requiredRules: [...input.requiredRules].sort(
        (a, b) => a.targetId.localeCompare(b.targetId) || a.ruleId.localeCompare(b.ruleId),
      ),
      dependencyDigest: input.dependencyDigest,
      contractHash: input.contractHash,
      policyHash: input.policyHash,
      reviewerConfigHash: input.reviewerConfigHash,
      promptHash: input.promptHash,
    }),
  )
}

/** A record is reusable only when completed, schema-valid, with ALL required checks (§11.3). */
export function recordReusable(record: ReviewRecord, requiredRuleIds: ReadonlySet<string>): boolean {
  if (record.stage === 'extract' || record.status !== 'completed' || record.response === undefined) return false
  if (!validateReviewResponse(record.response)) return false
  const seen = new Set<string>()
  for (const target of (record.response as ReviewResponse).targets) {
    for (const check of target.checks) seen.add(check.ruleId)
  }
  for (const ruleId of requiredRuleIds) {
    if (!seen.has(ruleId)) return false
  }
  return true
}

/** The distinguishing payload of a stage response for disagreement comparison (§11.3). */
function verdictFingerprint(response: ReviewResponse): Map<string, string> {
  const out = new Map<string, string>()
  for (const target of response.targets) {
    for (const check of target.checks) out.set(`${target.targetId}/${check.ruleId}`, check.result)
    if ('support' in target) out.set(`${target.targetId}/@support`, target.support)
    if ('adequacy' in target) out.set(`${target.targetId}/@adequacy`, String(target.adequacy))
    if ('issueImpact' in target) out.set(`${target.targetId}/@impact`, target.issueImpact)
  }
  return out
}

/**
 * §11.3 disagreement + fail-protection over prior records for ONE cache key:
 * differing verdicts on identical inputs are reviewer-disagreement (kind
 * 'disagreement', excluded from major→fail counting, aggregates to
 * needs-review); a latest pass never silently overwrites a fail.
 */
export function detectDisagreement(
  prior: (ReviewRecord & { kind?: 'disagreement' })[],
  next: ReviewRecord | undefined,
): { disagreement: boolean; failStands: boolean } {
  const fingerprints = prior
    .filter((record) => record.stage !== 'extract' && record.status === 'completed' && record.response !== undefined)
    .map((record) => verdictFingerprint(record.response as ReviewResponse))
  if (next?.stage !== 'extract' && next?.response !== undefined)
    fingerprints.push(verdictFingerprint(next.response as ReviewResponse))
  if (fingerprints.length < 2) {
    const anyFail = fingerprints.some((f) => [...f.values()].some((v) => v === 'fail'))
    return { disagreement: false, failStands: anyFail }
  }
  const first = fingerprints[0]!
  const disagreement = fingerprints.some((f) => {
    const keys = new Set([...first.keys(), ...f.keys()])
    for (const key of keys) {
      const a = first.get(key) ?? 'absent'
      const b = f.get(key) ?? 'absent'
      if (a !== b) return true
    }
    return false
  })
  const failStands = fingerprints.some((f) => [...f.values()].some((v) => v === 'fail'))
  return { disagreement, failStands }
}

/** The runtime-generated disagreement finding (§11.4; excluded from major→fail counting). */
export function disagreementFinding(targetIds: Id[]): Finding & { kind: 'disagreement' } {
  return {
    id: `finding_${randomUUID()}`,
    code: 'REVIEWER_DISAGREEMENT',
    targetIds,
    severity: 'major',
    explanation:
      'Review runs over identical inputs produced differing verdicts; aggregated to needs-review pending human adjudication.',
    evidenceIds: [],
    artifactSpans: [],
    repair: 'manual-review',
    kind: 'disagreement',
  }
}

/** All run ids of a request, oldest directory order first (for own-run reuse). */
export function requestRuns(root: string, projectId: string, requestId: string): Id[] {
  const store = new ReviewRunStore(root, projectId)
  try {
    return readdirSync(join(root, '.dsh', 'vwa', projectId, 'review-runs')).filter(
      (id) => store.readRequest(id)?.requestId === requestId,
    )
  } catch {
    return []
  }
}
