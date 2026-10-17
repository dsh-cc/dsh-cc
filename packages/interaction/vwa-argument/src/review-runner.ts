/**
 * Review runner (design docs/plans/2026-10-16-vwa-evidence-argument.md
 * §11, §13, §14.3, Appendix A): stage execution, budget enforcement,
 * caching, retry, and background-task registration.
 *
 * Budget (§13): maxCallsPerRun, per-run input/output token caps, wall clock,
 * per-call timeout, concurrency 1–4 of mutually independent tasks, and
 * reserved-output accounting — a call is only sent when the input estimate
 * plus the full reserved output cap fit the remaining budget; retries also
 * consume budget. Each task retries at most once, only for transient
 * transport errors or one schema repair (REVIEW_INVALID is never cached).
 *
 * Background: runs register through the ReviewTaskService (Appendix A four
 * behaviors; host mapping = jobs.start(kind 'vwa-review', label runId),
 * cancel→kill, get→get, emitProgress→updateProgress + cordis event). The
 * 10-per-owner overflow and a missing task service both surface as
 * REVIEW_UNAVAILABLE — never a synchronous long call blocking the turn.
 *
 * @module @dsh-cc/vwa-argument/review-runner
 */

import { readdirSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildReverseIndex, dependencyDigest as computeDependencyDigest, type ReverseIndex } from './dependencies.ts'
import { sha256Hex, stableJson } from './schema.ts'
import { planStage, type ReviewStage, type ReviewTask } from './review-plan.ts'
import { ReviewRunStore, cacheKey, detectDisagreement, disagreementFinding, recordReusable } from './review-run-store.ts'
import {
  ReviewInvalidError, parseReviewResponse, validateTaskResponse,
  type ReviewModelAdapter, type ReviewTaskContract, type ReviewMessages,
} from './review-adapter.ts'
import { BudgetTracker, type ReviewBudget } from './review-tasks.ts'
import { executeAudit } from './audit.ts'
export type { ReviewBudget } from './review-tasks.ts'
export { BudgetTracker, createHostTaskService, type ReviewTaskService } from './review-tasks.ts'
import { POLICY_VERSION } from './policy.ts'
import reviewSchemaJson from './contracts/review.schema.json' with { type: 'json' }
import type { Hash, Id, ProjectSnapshot, ReviewJobStatus, ReviewRecord, ReviewResponse } from './types.ts'

/** §11.4 rubric version (fixed rule set `humanities-v1`). */
export const RUBRIC_VERSION = 'humanities-v1'

/** Load one §11.2 stage prompt template from the package prompts directory. */
export function loadPrompt(stage: ReviewStage | 'extract' | 'align'): string {
  return readFileSync(new URL(`../prompts/${stage}.md`, import.meta.url), 'utf8')
}

/** §11.2 prompt template hash. */
export function promptHash(stage: ReviewStage | 'extract' | 'align'): Hash {
  return sha256Hex(stableJson({ policy: POLICY_VERSION, prompt: loadPrompt(stage) }))
}

/** §11.4 policy hash: schema version + applicability matrix + grade mapping identity. */
export function policyHash(): Hash {
  return sha256Hex(stableJson({ policy: POLICY_VERSION, rubric: RUBRIC_VERSION }))
}

/** The §11.4 per-stage envelope the user message carries. */
export function buildEnvelope(input: {
  stage: ReviewStage
  runId: Id
  task: ReviewTask
  contract: ProjectSnapshot['contract']
  dependencies: unknown
  maxOutputTokens: number
}): unknown {
  return {
    stage: input.stage,
    runId: input.runId,
    taskId: input.task.taskId,
    rubricVersion: RUBRIC_VERSION,
    requiredRules: input.task.requiredRules,
    contract: input.contract,
    targets: input.task.targetRefs,
    dependencies: input.task.envelope,
    budget: { maxOutputTokens: input.maxOutputTokens },
    context: input.dependencies,
  }
}

/** Stage response schema from the registered review contract (§13 forced-tool parameters). */
/** Stage response schema from the registered review contract (§13 forced-tool parameters). 'audit' never routes here (it is extract+align in audit.ts). */
export function responseSchemaFor(stage: Exclude<ReviewStage, 'audit'> | 'align'): object {
  const defs = reviewSchemaJson as { $defs: Record<string, object> }
  const defName = { sources: 'SourcesResponse', support: 'SupportResponse', claims: 'ClaimsResponse', arguments: 'ArgumentsResponse', align: 'AlignResponse' }[stage]
  return defs.$defs[defName!] ?? {}
}

export interface ReviewRunnerDeps {
  root: string
  adapter: ReviewModelAdapter
  budget: ReviewBudget
  contractHash: Hash
  /** Quote/context reader over source snapshots (§11.4: never file names alone). */
  readSnapshot?(sourceId: Id): string | undefined
  emitProgress?(event: { runId: Id; stage: string; message: string }): void
  now?: () => number
}

export interface ReviewRunOutcome {
  runId: Id
  status: ReviewJobStatus
  records: (ReviewRecord & { kind?: 'disagreement' })[]
  findings: unknown[]
  inputTokens: number
  outputTokens: number
  calls: number
  /** §12.1: audit discovered a new core claim → this run is needs-review; a new run is required. */
  newCoreDiscovered?: boolean
  /** §17.2 metrics from the audit stage, when it ran. */
  auditMetrics?: { extractedAtomicClaims: number; mappedAtomicClaims: number }
}

/**
 * Execute one review run inside the background task (the tool has already
 * returned). Persists records + usage; NEVER modifies the body or the author
 * graph (§10.6). The tool returns before this runs; stage completion emits
 * progress.
 */
export async function executeReviewRun(input: {
  deps: ReviewRunnerDeps
  runId: Id
  requestId: string
  stages: ReviewStage[]
  targetClaimIds: Id[]
  snapshot: ProjectSnapshot
  signal: AbortSignal
  /** Bound artifact text for the audit stage (§12); without it audit → incomplete. */
  artifact?: { id: Id; path: string; text: string }
  /** §13 review-max-context-chars-per-task: the over-long unit split threshold. */
  maxUnitChars?: number
}): Promise<ReviewRunOutcome> {
  const { deps } = input
  const store = new ReviewRunStore(deps.root, input.snapshot.projectId)
  store.initRun(input.runId)
  const budget = new BudgetTracker(deps.budget, deps.now)
  const index = buildReverseIndex(input.snapshot)
  const records: (ReviewRecord & { kind?: 'disagreement' })[] = []
  const findings: unknown[] = []
  let newCoreDiscovered = false
  let auditMetrics: { extractedAtomicClaims: number; mappedAtomicClaims: number } | undefined
  const requestRow = {
    schemaVersion: 1 as const,
    requestId: input.requestId,
    runId: input.runId,
    stage: input.stages.join('+'),
    targetClaimIds: input.targetClaimIds,
    status: 'running' as ReviewJobStatus,
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    startedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
  }
  store.writeRequest(input.runId, requestRow)
  deps.emitProgress?.({ runId: input.runId, stage: input.stages[0] ?? '', message: 'run started' })

  const finish = (finalStatus: ReviewJobStatus): ReviewRunOutcome => {
    const totals = {
      inputTokens: budget.inputTokens,
      outputTokens: budget.outputTokens,
      calls: budget.calls,
    }
    store.writeRequest(input.runId, {
      ...requestRow,
      status: finalStatus,
      ...totals,
      endedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    })
    deps.emitProgress?.({ runId: input.runId, stage: input.stages.at(-1) ?? '', message: `run ${finalStatus}` })
    return {
      runId: input.runId, status: finalStatus, records, findings, ...totals,
      ...(newCoreDiscovered ? { newCoreDiscovered } : {}),
      ...(auditMetrics === undefined ? {} : { auditMetrics }),
    }
  }

  for (const stage of input.stages) {
    if (stage === 'audit') {
      // §12 audit: extract + align over the whole bound artifact. Requires the
      // artifact text; without it the stage cannot run (incomplete, §12).
      if (input.artifact === undefined) return finish('incomplete')
      const audit = await executeAudit({
        adapter: deps.adapter,
        runId: input.runId,
        artifact: input.artifact,
        snapshot: input.snapshot,
        rubricVersion: RUBRIC_VERSION,
        contractHash: deps.contractHash,
        policyHash: policyHash(),
        reviewerConfigHash: reviewerConfigHash(deps),
        maxOutputTokens: deps.budget.maxOutputTokensPerCall,
        maxUnitChars: input.maxUnitChars ?? 48_000,
        signal: input.signal,
      }).catch((error: unknown) => {
        // Runtime validation failure: error records, never semantic findings (§11.4).
        const code = error instanceof ReviewInvalidError || (error as { code?: string })?.code === 'REVIEW_INVALID' ? 'REVIEW_INVALID' : 'REVIEW_UNAVAILABLE'
        records.push({
          runId: input.runId, stage: 'audit', targetRefs: [], dependencyDigest: '',
          contractHash: deps.contractHash, policyHash: policyHash(), reviewerConfigHash: reviewerConfigHash(deps),
          promptHash: '', inputHash: '', status: 'error', inputTokens: 0, outputTokens: 0,
          startedAt: '', endedAt: new Date().toISOString(), errorCode: code,
        })
        return undefined
      })
      if (audit === undefined) return finish('incomplete')
      // §12.1: a discovered new core claim marks the run needs-review — a
      // NEW run is required; online reclassification is not allowed.
      if (audit.needsReview) newCoreDiscovered = true
      store.writeRecord(input.runId, audit.extractionRecord as unknown as ReviewRecord & { kind?: 'disagreement' })
      store.writeRecord(input.runId, audit.alignRecord as ReviewRecord & { kind?: 'disagreement' })
      records.push(audit.extractionRecord as unknown as ReviewRecord & { kind?: 'disagreement' }, audit.alignRecord)
      findings.push(...audit.findings)
      auditMetrics = audit.metrics
      deps.emitProgress?.({ runId: input.runId, stage: 'audit', message: 'extract+align done' })
      continue
    }
    const tasks = planStage({ stage, snapshot: input.snapshot, index, targetClaimIds: input.targetClaimIds, core: new Set() })
    for (const task of tasks) {
      if (budget.wallExceeded()) return finish('incomplete')
      if (input.signal.aborted) return finish('cancelled')
      const outcome = await executeTask({ deps, runId: input.runId, requestId: input.requestId, stage, task, snapshot: input.snapshot, index, store, budget, signal: input.signal, records, findings })
      if (outcome === 'budget-exhausted') return finish('budget-exhausted')
      if (input.signal.aborted) return finish('cancelled')
    }
    deps.emitProgress?.({ runId: input.runId, stage, message: `stage ${stage} done` })
  }
  return finish('completed')
}

/** Execute one planned task: cache → disagreement → dispatch → validate → retry → persist. */
async function executeTask(input: {
  deps: ReviewRunnerDeps
  runId: Id
  requestId: string
  stage: ReviewStage
  task: ReviewTask
  snapshot: ProjectSnapshot
  index: ReverseIndex
  store: ReviewRunStore
  budget: BudgetTracker
  signal: AbortSignal
  records: (ReviewRecord & { kind?: 'disagreement' })[]
  findings: unknown[]
}): Promise<'ok' | 'budget-exhausted'> {
  const { deps, task, stage } = input
  const requiredRules = new Set(task.requiredRules.map((rule) => rule.ruleId))
  const depDigest = computeDependencyDigest(input.index, [task.targetRefs[0]?.id ?? ''], [])
  const key = cacheKey({
    stage,
    targetRefs: task.targetRefs,
    dependencyDigest: depDigest,
    contractHash: deps.contractHash,
    policyHash: policyHash(),
    reviewerConfigHash: reviewerConfigHash(deps),
    promptHash: promptHash(stage),
  })
  const contract: ReviewTaskContract = {
    stage: stage as Exclude<ReviewStage, 'audit'>,
    targetIds: new Set(task.targetIds),
    requiredRules: new Map(task.targetRefs.map((ref) => [ref.id, new Set(task.requiredRules.filter((rule) => rule.targetId === ref.id).map((rule) => rule.ruleId))])),
    knownEvidenceIds: knownEvidenceIds(input.index, task),
    groupEvidenceIds: groupEvidenceIds(input.index, task),
  }

  // ---- cache + disagreement scan (§11.3) ----
  // Disagreement is detected over ALL prior records with this key (original
  // records); reuse is limited to the CURRENT requestId's own prior records —
  // a fresh requestId is an explicit re-review and re-dispatches (D19), while
  // an interrupted run's completed tasks are saved and reused (§13).
  const allPrior = collectCachedRecords(deps.root, input.snapshot.projectId, key)
  const ownRunIds = new Set(ownRunsForRequest(deps.root, input.snapshot.projectId, input.requestId))
  const prior = allPrior
  const reusable = allPrior.find((record) => ownRunIds.has(record.runId) && recordReusable(record, requiredRules))
  if (reusable !== undefined) {
    const { disagreement } = detectDisagreement(prior, undefined)
    if (disagreement) input.findings.push(disagreementFinding([...task.targetIds]))
    input.records.push({ ...reusable, runId: input.runId })
    input.store.appendUsage(input.runId, { runId: input.runId, taskId: task.taskId, seq: 0, kind: 'reused', inputTokens: 0, outputTokens: 0, method: 'tokenizer' })
    return 'ok'
  }

  // ---- budget reservation (§13) ----
  const envelope = buildEnvelope({
    stage,
    runId: input.runId,
    task,
    contract: input.snapshot.contract,
    dependencies: snapshotTextDeps(input),
    maxOutputTokens: deps.budget.maxOutputTokensPerCall,
  })
  const messages: ReviewMessages = [
    { role: 'system', content: loadPrompt(stage) },
    { role: 'user', content: stableJson(envelope) },
  ]
  const counted = await deps.adapter.countInput(messages)
  if (!input.budget.reserve(counted.tokens)) {
    input.store.appendUsage(input.runId, { runId: input.runId, taskId: task.taskId, seq: 0, kind: 'error', inputTokens: 0, outputTokens: 0, method: counted.method })
    return 'budget-exhausted'
  }
  const startedAt = new Date(deps.now?.() ?? Date.now()).toISOString()
  const buildRecord = (errorCode: string | undefined, response: ReviewResponse | undefined, usage?: { inputTokens?: number; outputTokens?: number }): ReviewRecord => {
    input.budget.settle(counted.tokens, usage)
    return {
      runId: input.runId,
      stage,
      targetRefs: task.targetRefs,
      dependencyDigest: depDigest,
      contractHash: deps.contractHash,
      policyHash: policyHash(),
      reviewerConfigHash: reviewerConfigHash(deps),
      promptHash: promptHash(stage),
      // The §11.3 cache key doubles as the record's input hash: it is a hash
      // over exactly the task's frozen inputs.
      inputHash: key,
      status: errorCode === undefined ? 'completed' : 'error',
      inputTokens: usage?.inputTokens ?? counted.tokens,
      outputTokens: usage?.outputTokens ?? deps.budget.maxOutputTokensPerCall,
      startedAt,
      endedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(response === undefined ? {} : { response }),
    }
  }

  // ---- dispatch + one retry (§13: transport error or one schema repair) ----
  let response: ReviewResponse | undefined
  let usage: { inputTokens?: number; outputTokens?: number } | undefined
  for (let attempt = 1; ; attempt += 1) {
    try {
      const call = await deps.adapter.prepareReviewCall({
        messages,
        responseSchema: responseSchemaFor(stage as Exclude<ReviewStage, 'audit'>),
        maxOutputTokens: deps.budget.maxOutputTokensPerCall,
        signal: input.signal,
      })
      void call.describe() // derived from the prepared call; hash closure above
      const result = await dispatchWithTimeout(call, deps.budget.callTimeoutMs, input.signal)
      usage = {}
      if (result.inputTokens !== undefined) usage.inputTokens = result.inputTokens
      if (result.outputTokens !== undefined) usage.outputTokens = result.outputTokens
      response = parseReviewResponse(result.raw)
      validateTaskResponse(response, contract)
      break
    } catch (error) {
      if (input.signal.aborted) {
        const rec = { ...buildRecord('CANCELLED', undefined, usage), status: 'cancelled' as const }
        input.records.push(rec)
        input.store.writeRecord(input.runId, rec)
        input.store.appendUsage(input.runId, { runId: input.runId, taskId: task.taskId, seq: 0, kind: 'error', inputTokens: rec.inputTokens, outputTokens: rec.outputTokens, method: counted.method })
        return 'ok'
      }
      const invalid = error instanceof ReviewInvalidError
      if (attempt >= 2) {
        const rec = buildRecord(invalid ? 'REVIEW_INVALID' : 'REVIEW_UNAVAILABLE', undefined, usage)
        input.records.push(rec)
        input.store.writeRecord(input.runId, rec)
        input.store.appendUsage(input.runId, { runId: input.runId, taskId: task.taskId, seq: 0, kind: 'error', inputTokens: rec.inputTokens, outputTokens: rec.outputTokens, method: counted.method })
        return 'ok'
      }
      input.store.appendUsage(input.runId, { runId: input.runId, taskId: task.taskId, seq: attempt, kind: 'repair', inputTokens: counted.tokens, outputTokens: deps.budget.maxOutputTokensPerCall, method: counted.method })
    }
  }
  const rec = buildRecord(undefined, response, usage)
  input.records.push(rec)
  input.store.writeRecord(input.runId, rec)
  const { disagreement } = detectDisagreement(prior, rec)
  if (disagreement) input.findings.push(disagreementFinding([...task.targetIds]))
  input.store.appendUsage(input.runId, { runId: input.runId, taskId: task.taskId, seq: 0, kind: 'actual', inputTokens: rec.inputTokens, outputTokens: rec.outputTokens, method: counted.method })
  return 'ok'
}

/** Dispatch with per-call timeout + runner abort (§13 review-call-timeout-ms). */
async function dispatchWithTimeout(
  call: { dispatch(): Promise<{ raw: string; inputTokens?: number; outputTokens?: number }> },
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ raw: string; inputTokens?: number; outputTokens?: number }> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = AbortSignal.any([signal, timeout])
  const timer = new Promise<never>((_resolve, reject) => {
    if (combined.aborted) reject(new Error(combined.reason instanceof Error ? combined.reason.message : 'aborted'))
    else combined.addEventListener('abort', () => reject(new Error('review call timeout')), { once: true })
  })
  return Promise.race([call.dispatch(), timer])
}

function reviewerConfigHash(deps: ReviewRunnerDeps): Hash {
  // §11.2: hash over the actually dispatched configuration — model identity,
  // provider, and the adapter's effective options (temperature, reasoning).
  return sha256Hex(stableJson(deps.adapter.configFingerprint()))
}

function knownEvidenceIds(index: ReverseIndex, task: ReviewTask): Set<string> {
  const ids = new Set<string>()
  for (const ref of task.targetRefs) {
    const group = index.groups.get(ref.id)
    if (group !== undefined) for (const id of group.evidenceIds) ids.add(id)
    const issue = index.issues.get(ref.id)
    if (issue !== undefined) for (const id of issue.evidenceIds) ids.add(id)
    const argument = index.arguments.get(ref.id)
    if (argument !== undefined) {
      for (const groupId of argument.evidenceGroupIds) {
        for (const id of index.groups.get(groupId)?.evidenceIds ?? []) ids.add(id)
      }
    }
  }
  return ids
}

function groupEvidenceIds(index: ReverseIndex, task: ReviewTask): Map<Id, readonly Id[]> {
  const out = new Map<Id, readonly Id[]>()
  for (const ref of task.targetRefs) {
    const group = index.groups.get(ref.id)
    if (group !== undefined) out.set(ref.id, group.evidenceIds)
  }
  return out
}

/** Actual quoted text/context dependencies (§11.4: never file names alone). */
function snapshotTextDeps(input: { deps: ReviewRunnerDeps; index: ReverseIndex; task: ReviewTask }): unknown {
  if (input.deps.readSnapshot === undefined) return undefined
  const texts: unknown[] = []
  for (const ref of input.task.targetRefs) {
    const group = input.index.groups.get(ref.id)
    if (group === undefined) continue
    for (const evidenceId of group.evidenceIds) {
      const evidence = input.index.evidence.get(evidenceId)
      if (evidence === undefined) continue
      const snapshot = input.deps.readSnapshot(evidence.sourceId)
      if (snapshot === undefined) continue
      texts.push({
        evidenceId,
        sourceId: evidence.sourceId,
        quote: snapshot.slice(evidence.span.start, evidence.span.end),
        context: snapshot.slice(evidence.contextSpan.start, evidence.contextSpan.end),
      })
    }
  }
  return texts
}

/** All prior records with the same cache key across every run (original records, §11.3). */
export function collectCachedRecords(root: string, projectId: string, key: Hash): (ReviewRecord & { kind?: 'disagreement' })[] {
  const store = new ReviewRunStore(root, projectId)
  const base = join(root, '.dsh', 'vwa', projectId, 'review-runs')
  const out: (ReviewRecord & { kind?: 'disagreement' })[] = []
  let runIds: string[]
  try {
    runIds = readdirSync(base)
  } catch {
    return out
  }
  for (const runId of runIds) {
    for (const record of store.readRecords(runId)) {
      if (record.inputHash === key) out.push(record)
    }
  }
  return out
}

/** Run ids previously started under one requestId (§10.6 idempotency closure). */
function ownRunsForRequest(root: string, projectId: string, requestId: string): string[] {
  const store = new ReviewRunStore(root, projectId)
  const base = join(root, '.dsh', 'vwa', projectId, 'review-runs')
  const out: string[] = []
  try {
    for (const runId of readdirSync(base)) {
      const request = store.readRequest(runId)
      if (request?.requestId === requestId) out.push(runId)
    }
  } catch {
    return []
  }
  return out
}
