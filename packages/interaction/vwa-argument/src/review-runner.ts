/** Background review execution with frozen inputs, immutable history and shared attempt accounting. */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildReverseIndex } from './dependencies.ts'
import { sha256Hex, stableJson } from './schema.ts'
import { planStage, type ReviewStage, type ReviewTask } from './review-plan.ts'
import {
  ReviewRunStore,
  cacheKey,
  detectDisagreement,
  disagreementFinding,
} from './review-run-store.ts'
import {
  ReviewInvalidError,
  parseReviewResponse,
  validateTaskResponse,
  type ReviewModelAdapter,
  type ReviewTaskContract,
  type ReviewMessages,
} from './review-adapter.ts'
import { BudgetTracker, type ReviewBudget } from './review-tasks.ts'
import { ReviewCaller, ReviewBudgetError } from './review-call.ts'
import { executeAudit } from './audit.ts'
import { ProjectStore, type Fail } from './store.ts'
import { taskDependencyDigest, taskEnvelope, taskDependencyIds } from './review-input.ts'
import { currentReviews } from './review-current.ts'
import { validateEvidenceAgainstSnapshot } from './graph.ts'
import { RUBRIC_VERSION, loadPrompt, promptHash, policyHash, responseSchemaFor, RULES } from './review-contract.ts'
import { allRecords, continuePreCheck, frozenCoreSet, reusableRecord } from './review-continue.ts'
import { cycleUsage, remainingCycleBudget } from './review-cycle.ts'
import type { Hash, Id, ProjectSnapshot, ReviewJobStatus, ReviewRecord } from './types.ts'
export type { ReviewBudget } from './review-tasks.ts'
export { BudgetTracker, createHostTaskService, type ReviewTaskService } from './review-tasks.ts'
export { RUBRIC_VERSION, loadPrompt, promptHash, policyHash, responseSchemaFor } from './review-contract.ts'
// Re-exported for existing importers; the implementation lives in review-continue.ts.
export { collectCachedRecords } from './review-continue.ts'

/** Public envelope constructor retained for tools inspecting planned inputs. */
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
    ruleDefinitions: Object.fromEntries(input.task.requiredRules.map((r) => [r.ruleId, RULES[r.ruleId]])),
    contract: input.contract,
    targets: input.task.targetRefs,
    dependencies: input.task.envelope,
    budget: { maxOutputTokens: input.maxOutputTokens },
    context: input.dependencies,
  }
}
export interface ReviewRunnerDeps {
  root: string
  adapter: ReviewModelAdapter
  budget: ReviewBudget
  contractHash: Hash
  readSnapshot?(sourceId: Id): string | undefined
  emitProgress?(event: { runId: Id; stage: string; message: string }): void
  now?: () => number
  maxArtifactChars?: number
  maxContextChars?: number
}
export interface ReviewRunOutcome {
  runId: Id
  status: ReviewJobStatus
  records: ReviewRecord[]
  findings: unknown[]
  inputTokens: number
  outputTokens: number
  calls: number
  newCoreDiscovered?: boolean
  newClaimProposals?: unknown[]
  auditMetrics?: { extractedAtomicClaims: number; mappedAtomicClaims: number }
  /** Set when the run refused to execute anything (replay returns this failure). */
  refusal?: Fail
}
/** Run independently of the authoring turn. No graph or artifact writes. */
export async function executeReviewRun(input: {
  deps: ReviewRunnerDeps
  runId: Id
  requestId: string
  stages: ReviewStage[]
  targetClaimIds: Id[]
  snapshot: ProjectSnapshot
  signal: AbortSignal
  artifact?: { id: Id; path: string; text: string }
  maxUnitChars?: number
  /** §A.2: continue mode — reuse completed records across requestIds. */
  continueMode?: boolean
}): Promise<ReviewRunOutcome> {
  const { deps, snapshot, runId } = input
  const store = new ReviewRunStore(deps.root, snapshot.projectId)
  store.initRun(runId)
  // §A.4: a continue run spends only what its review cycle has left (review-cycle.ts).
  const runBudget = input.continueMode
    ? remainingCycleBudget(deps.budget, cycleUsage(deps.root, snapshot.projectId, runId))
    : deps.budget
  const budget = new BudgetTracker(runBudget, deps.now)
  const records: ReviewRecord[] = [],
    findings: unknown[] = []
  const history = allRecords(deps.root, snapshot.projectId)
  const index = buildReverseIndex(snapshot)
  const startedAt = new Date(deps.now?.() ?? Date.now()).toISOString()
  const request = {
    ...store.readRequest(runId),
    schemaVersion: 1 as const,
    requestId: input.requestId,
    runId,
    stage: input.stages.join('+'),
    targetClaimIds: input.targetClaimIds,
    ...(input.artifact ? { artifactId: input.artifact.id } : {}),
    ...(input.continueMode ? { continue: true } : {}),
    status: 'running' as ReviewJobStatus,
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    startedAt,
  }
  store.reserveRequest(runId, request)
  Object.assign(request, store.readRequest(runId))
  let coreDiscovered = false,
    newClaimProposals: unknown[] = [],
    auditMetrics: ReviewRunOutcome['auditMetrics']
  const finish = (status: ReviewJobStatus, refusal?: Fail): ReviewRunOutcome => {
    const totals = { inputTokens: budget.inputTokens, outputTokens: budget.outputTokens, calls: budget.calls }
    store.writeOutcome(runId, {
      status,
      ...totals,
      findings,
      newClaimProposals,
      ...(coreDiscovered ? { newCoreDiscovered: true } : {}),
      ...(auditMetrics ? { auditMetrics } : {}),
      ...(refusal ? { refusal } : {}),
    })
    store.writeRequest(runId, {
      ...request,
      ...totals,
      status,
      endedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    })
    deps.emitProgress?.({ runId, stage: input.stages.at(-1) ?? '', message: `run ${status}` })
    return {
      runId,
      status,
      records,
      findings,
      newClaimProposals,
      ...totals,
      ...(coreDiscovered ? { newCoreDiscovered: true } : {}),
      ...(auditMetrics ? { auditMetrics } : {}),
      ...(refusal ? { refusal } : {}),
    }
  }
  const caller = new ReviewCaller(
    deps.adapter,
    budget,
    runBudget,
    input.signal,
    (row) => {
      store.appendUsage(runId, { runId, ...row })
      store.writeRequest(runId, {
        ...request,
        inputTokens: budget.inputTokens,
        outputTokens: budget.outputTokens,
        calls: budget.calls,
      })
    },
    deps.maxContextChars ?? 48_000,
  )
  let configHash = ''
  const save = (record: ReviewRecord) => {
    records.push(record)
    store.writeRecord(runId, record)
  }
  const errorRecord = (stage: ReviewStage, error: unknown, task?: ReviewTask): ReviewRecord => ({
    runId,
    stage,
    targetRefs: task?.targetRefs ?? [],
    dependencyDigest: task ? taskDependencyDigest(index, task, records) : '',
    contractHash: deps.contractHash,
    policyHash: policyHash(),
    reviewerConfigHash: configHash,
    promptHash: stage === 'audit' ? '' : promptHash(stage),
    inputHash: '',
    status: input.signal.aborted ? 'cancelled' : error instanceof ReviewBudgetError ? 'budget-exhausted' : 'error',
    inputTokens: 0,
    outputTokens: 0,
    startedAt,
    endedAt: new Date().toISOString(),
    errorCode: input.signal.aborted ? 'CANCELLED' : ((error as { code?: string })?.code ?? 'REVIEW_UNAVAILABLE'),
  })
  try {
    input.signal.throwIfAborted()
    await deps.adapter.initialize?.(deps.budget.maxOutputTokensPerCall, input.signal)
    configHash = sha256Hex(stableJson(deps.adapter.configFingerprint()))
    // Broken hashes/quotes fail before any semantic dispatch.
    if (deps.readSnapshot)
      for (const source of snapshot.sources) {
        const text = deps.readSnapshot(source.id)
        if (text === undefined || sha256Hex(text) !== source.snapshotHash)
          throw new ReviewInvalidError(`EVID-01: snapshot missing or changed for ${source.id}`)
        for (const ev of snapshot.evidence.filter((e) => e.sourceId === source.id))
          validateEvidenceAgainstSnapshot(ev, text)
      }
    const frozenCore = frozenCoreSet({
      root: deps.root,
      index,
      snapshot,
      ...(input.artifact ? { artifact: { id: input.artifact.id, text: input.artifact.text } } : {}),
    })
    // §A.2 guard, shared with the tool pre-check: a continue run where every
    // planned task AND the requested audit already have reusable completed
    // records refuses to re-execute anything. When work remains, the audit
    // always re-executes: fresh upstream judgments change its dependency
    // digest, so a completed audit can only be reused through this guard.
    const continueInput = {
      root: deps.root,
      adapter: deps.adapter,
      contractHash: deps.contractHash,
      snapshot,
      stages: input.stages,
      targetClaimIds: input.targetClaimIds,
      ...(input.artifact ? { artifact: { id: input.artifact.id, text: input.artifact.text } } : {}),
      ...(input.maxUnitChars === undefined ? {} : { maxUnitChars: input.maxUnitChars }),
      ...(deps.maxContextChars === undefined ? {} : { maxContextChars: deps.maxContextChars }),
      budget: deps.budget,
      runId,
    }
    if (input.continueMode) {
      const refusal = continuePreCheck(continueInput)
      if (refusal) return finish(refusal.code === 'BUDGET_EXHAUSTED' ? 'budget-exhausted' : 'completed', refusal)
    }
    for (const stage of input.stages) {
      input.signal.throwIfAborted()
      if (budget.wallExceeded()) return finish('incomplete')
      if (stage === 'audit') {
        if (!input.artifact) return finish('incomplete')
        if (input.artifact.text.length > (deps.maxArtifactChars ?? 120_000))
          throw new ReviewInvalidError('artifact exceeds review-max-artifact-chars; full audit refused')
        // Audit and delivery must see the same current judgments, including
        // prior second opinions; semantic digests collapse reused copies.
        const auditRecords = currentReviews(snapshot, [...history, ...records], input.targetClaimIds, configHash).records
        const audit = await executeAudit({
          adapter: deps.adapter,
          runId,
          artifact: input.artifact,
          snapshot,
          rubricVersion: RUBRIC_VERSION,
          contractHash: deps.contractHash,
          policyHash: policyHash(),
          reviewerConfigHash: configHash,
          maxOutputTokens: deps.budget.maxOutputTokensPerCall,
          maxUnitChars: input.maxUnitChars ?? deps.maxContextChars ?? 48_000,
          signal: input.signal,
          caller,
          records: auditRecords,
          coreClaimIds: [...frozenCore],
        })
        save(audit.extractionRecord)
        save(audit.alignRecord)
        findings.push(...audit.findings)
        coreDiscovered = audit.needsReview
        auditMetrics = audit.metrics
        newClaimProposals = audit.newClaimProposals
        continue
      }
      const tasks = planStage({ stage, snapshot, index, targetClaimIds: input.targetClaimIds, core: frozenCore })
      // Independent tasks may overlap. Arguments retain their topological ordering.
      for (let start = 0; start < tasks.length; start += stage === 'arguments' ? 1 : deps.budget.concurrency) {
        const batch = tasks.slice(start, start + (stage === 'arguments' ? 1 : deps.budget.concurrency))
        const outcomes = await Promise.allSettled(
          batch.map(async (task) => {
            const upstream = currentReviews(
              snapshot,
              [...history, ...records],
              input.targetClaimIds,
              configHash,
            ).records
            const dep = taskDependencyDigest(index, task, upstream)
            const key = cacheKey({
              stage,
              targetRefs: task.targetRefs,
              requiredRules: task.requiredRules,
              dependencyDigest: dep,
              contractHash: deps.contractHash,
              policyHash: policyHash(),
              reviewerConfigHash: configHash,
              promptHash: promptHash(stage),
            })
            const prior = history.filter((r) => r.inputHash === key)
            const ownRuns = new Set(requestRuns(deps.root, snapshot.projectId, input.requestId))
            const reusable = reusableRecord(prior, task, input.continueMode === true, ownRuns)
            if (reusable) {
              save({ ...reusable, runId })
              // §A.3.5: reused records appear in the ledger with zero tokens.
              if (input.continueMode === true)
                store.appendUsage(runId, {
                  runId,
                  taskId: task.taskId,
                  seq: budget.calls,
                  kind: 'reused',
                  inputTokens: 0,
                  outputTokens: 0,
                  method: 'tokenizer',
                })
              return
            }
            const envelope = taskEnvelope({
              stage,
              runId,
              task,
              snapshot,
              records: upstream,
              maxOutputTokens: deps.budget.maxOutputTokensPerCall,
              ...(deps.readSnapshot ? { readSnapshot: deps.readSnapshot } : {}),
            })
            const messages: ReviewMessages = [
              { role: 'system', content: loadPrompt(stage) },
              { role: 'user', content: stableJson(envelope) },
            ]
            const knownIds = new Set(taskDependencyIds(index, task))
            for (const e of snapshot.evidence)
              if (
                task.targetIds.includes(e.id) ||
                (envelope as { context: { evidence: { id: string }[] } }).context.evidence.some((x) => x.id === e.id)
              )
                knownIds.add(e.id)
            const contract: ReviewTaskContract = {
              stage,
              targetIds: new Set(task.targetIds),
              requiredRules: new Map(
                task.targetRefs.map((ref) => [
                  ref.id,
                  new Set(task.requiredRules.filter((r) => r.targetId === ref.id).map((r) => r.ruleId)),
                ]),
              ),
              knownEvidenceIds: new Set([...knownIds].filter((id) => index.evidence.has(id))),
              groupEvidenceIds: new Map(
                task.targetRefs
                  .filter((r) => index.groups.has(r.id))
                  .map((r) => [r.id, index.groups.get(r.id)!.evidenceIds]),
              ),
            }
            try {
              const result = await caller.call(task.taskId, messages, responseSchemaFor(stage), (raw) => {
                const response = parseReviewResponse(raw)
                validateTaskResponse(response, contract)
                return response
              })
              // Runtime owns finding IDs and fixed rule severities.
              result.raw.findings = result.raw.findings.map((f) => ({
                ...f,
                id: `finding_${cryptoUuid()}`,
                severity: 'major' as const,
              }))
              const record: ReviewRecord = {
                runId,
                stage,
                targetRefs: task.targetRefs,
                dependencyDigest: dep,
                contractHash: deps.contractHash,
                policyHash: policyHash(),
                reviewerConfigHash: configHash,
                promptHash: promptHash(stage),
                inputHash: key,
                status: 'completed',
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                startedAt,
                endedAt: new Date().toISOString(),
                response: result.raw,
              }
              save(record)
              if (detectDisagreement(prior, record).disagreement) {
                const finding = disagreementFinding(task.targetIds)
                findings.push(finding)
                save({ ...record, kind: 'disagreement', response: { ...result.raw, findings: [finding] } })
              }
            } catch (error) {
              save(errorRecord(stage, error, task))
              throw error
            }
          }),
        )
        const failed = outcomes.find((r) => r.status === 'rejected')
        if (failed?.status === 'rejected')
          return finish(
            input.signal.aborted
              ? 'cancelled'
              : failed.reason instanceof ReviewBudgetError
                ? 'budget-exhausted'
                : 'incomplete',
          )
      }
      deps.emitProgress?.({ runId, stage, message: `stage ${stage} done` })
    }
    // A concurrent related mutation makes the frozen result historical, never current.
    const live = new ProjectStore(deps.root, snapshot.projectId).readHead()
    if (live.ok) {
      const before = stableJson({
        contract: snapshot.contract,
        dependencies: input.targetClaimIds.map((id) =>
          taskDependencyDigest(
            index,
            {
              taskId: '',
              stage: 'claims',
              targetRefs: [{ id, entityVersion: index.claims.get(id)?.entityVersion ?? 1 }],
              targetIds: [id],
              requiredRules: [],
              envelope: {},
            },
            [],
          ),
        ),
      })
      const nextIndex = buildReverseIndex(live.data.snapshot)
      const after = stableJson({
        contract: live.data.snapshot.contract,
        dependencies: input.targetClaimIds.map((id) =>
          taskDependencyDigest(
            nextIndex,
            {
              taskId: '',
              stage: 'claims',
              targetRefs: [{ id, entityVersion: nextIndex.claims.get(id)?.entityVersion ?? 1 }],
              targetIds: [id],
              requiredRules: [],
              envelope: {},
            },
            [],
          ),
        ),
      })
      if (before !== after) return finish('incomplete')
      if (
        input.artifact &&
        live.data.snapshot.artifacts.find((a) => a.id === input.artifact!.id)?.contentHash !==
          sha256Hex(input.artifact.text)
      )
        return finish('incomplete')
    }
    // §A.3.6: in continue mode a run reaches 'completed' only when every
    // planned task has a fresh or reused completed record — any task without
    // one fails the stage loop and finishes 'incomplete' via existing logic.
    return finish(coreDiscovered ? 'incomplete' : 'completed')
  } catch (error) {
    const stage = input.stages.at(-1) ?? 'audit'
    save(errorRecord(stage, error))
    return finish(
      input.signal.aborted ? 'cancelled' : error instanceof ReviewBudgetError ? 'budget-exhausted' : 'incomplete',
    )
  }
}
import { randomUUID as cryptoUuid } from 'node:crypto'
function requestRuns(root: string, projectId: string, requestId: string): Id[] {
  const store = new ReviewRunStore(root, projectId)
  try {
    return readdirSync(join(root, '.dsh', 'vwa', projectId, 'review-runs')).filter(
      (id) => store.readRequest(id)?.requestId === requestId,
    )
  } catch {
    return []
  }
}
