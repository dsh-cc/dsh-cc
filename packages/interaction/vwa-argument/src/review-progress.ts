/**
 * Report stage-level progress and per-task failure detail (Feature D,
 * design docs/plans/2026-10-19-vwa-lane2-feature-d-observability-ux.md
 * §D.2.1–D.2.2). Computed from the FULL record store — failed records are
 * filtered out of currentReviews, so they are invisible there.
 *
 * @module @dsh-cc/vwa-argument/review-progress
 */

import { planStage } from './review-plan.ts'
import { currentReviews, matchesReviewTask, auditDependencyDigest } from './review-current.ts'
import { taskDependencyDigest } from './review-input.ts'
import { sha256Hex } from './schema.ts'
import { policyHash, promptHash, semanticContractHash } from './review-contract.ts'
import type { ReverseIndex } from './dependencies.ts'
import type { Id, ProjectSnapshot, ReviewFailure, ReviewRecord, ReviewStage, StageProgress } from './types.ts'

const PROGRESS_STAGES = ['sources', 'support', 'claims', 'arguments'] as const

// Feature D error classification (§D.2.1). Call timeouts surface as
// REVIEW_UNAVAILABLE (the runner has no separate timeout errorCode literal).
const CHANNEL_CODES = new Set(['REVIEW_UNAVAILABLE', 'REVIEW_TRUNCATED', 'REVIEW_CONFIG_DRIFT'])
const SCHEMA_CODES = new Set(['REVIEW_INVALID'])
const BUDGET_CODES = new Set(['BUDGET_EXHAUSTED', 'CONTEXT_TOO_LARGE', 'REVIEW_RETRY_BUDGET'])

function zero(): StageProgress {
  return {
    total: 0,
    completed: 0,
    failed: 0,
    notRun: 0,
    channelErrors: 0,
    schemaErrors: 0,
    budgetErrors: 0,
  }
}

function classify(errorCode: string | undefined, progress: StageProgress): void {
  if (errorCode === undefined) return
  if (CHANNEL_CODES.has(errorCode)) progress.channelErrors += 1
  else if (SCHEMA_CODES.has(errorCode)) progress.schemaErrors += 1
  else if (BUDGET_CODES.has(errorCode)) progress.budgetErrors += 1
}

/** Record filenames are random UUIDs, so directory order is never chronology. */
function lastTaskStatus(records: ReviewRecord[]): ReviewRecord['status'] | undefined {
  // When timestamps tie, retain the more actionable status, independently of read order.
  const priority = { completed: 0, cancelled: 1, 'budget-exhausted': 2, error: 3 }
  return [...records].sort((a, b) =>
    a.endedAt.localeCompare(b.endedAt) || a.startedAt.localeCompare(b.startedAt) ||
    priority[a.status] - priority[b.status] || a.runId.localeCompare(b.runId),
  ).at(-1)?.status
}

export function computeStageProgress(input: {
  snapshot: ProjectSnapshot
  index: ReverseIndex
  core: ReadonlySet<Id>
  targets: Id[]
  records: ReviewRecord[]
  claimsBatchSize: number
  reviewerConfigHash?: string
  artifact?: { id: Id; text: string }
}): { stageProgress: Record<ReviewStage, StageProgress>; failures: ReviewFailure[] } {
  const stageProgress: Record<ReviewStage, StageProgress> = {
    sources: zero(),
    support: zero(),
    claims: zero(),
    arguments: zero(),
    // 'audit' is planned/extracted in audit.ts (extract+align), not by planStage.
    audit: zero(),
  }
  const failures: ReviewFailure[] = []
  const records = input.records.filter((r) => r.kind !== 'disagreement')
  const current = currentReviews(input.snapshot, records, input.targets, input.reviewerConfigHash).records
  const contractHash = semanticContractHash(input.snapshot.contract)
  for (const stage of PROGRESS_STAGES) {
    const progress = stageProgress[stage]
    const stageRecords = records.filter((r) => r.stage === stage)
    const lastStatus = lastTaskStatus(stageRecords)
    if (lastStatus) progress.lastRunStatus = lastStatus
    for (const record of stageRecords)
      if (record.status === 'error' || record.status === 'budget-exhausted') {
        classify(record.errorCode, progress)
        failures.push({
          runId: record.runId,
          stage,
          targetIds: record.targetRefs.map((ref) => ref.id),
          errorCode: record.errorCode ?? 'REVIEW_UNAVAILABLE',
          ...(record.errorDetail ? { errorDetail: record.errorDetail } : {}),
          endedAt: record.endedAt,
        })
      }
    const tasks = planStage({
      stage,
      snapshot: input.snapshot,
      index: input.index,
      targetClaimIds: input.targets,
      core: input.core,
      claimsBatchSize: input.claimsBatchSize,
    })
    progress.total = tasks.length
    for (const task of tasks) {
      const expected = {
        contractHash,
        dependencyDigest: taskDependencyDigest(input.index, task, current),
        ...(input.reviewerConfigHash === undefined ? {} : { reviewerConfigHash: input.reviewerConfigHash }),
      }
      const matching = stageRecords.filter((r) =>
        matchesReviewTask(r, task, expected) && (r.status !== 'completed' || current.includes(r)),
      )
      const latest = [...matching].sort(
        (a, b) => a.endedAt.localeCompare(b.endedAt) || a.runId.localeCompare(b.runId),
      ).at(-1)
      if (latest?.status === 'error' || latest?.status === 'budget-exhausted') progress.failed += 1
      else if (matching.some((r) => r.status === 'completed')) progress.completed += 1
      else progress.notRun += 1
    }
  }
  // Audit is one artifact task implemented by an extract/align pair, not a
  // planStage task. Keep both sub-stages and aggregate runner errors visible.
  const progress = stageProgress.audit
  const auditRecords = records.filter((r) => ['audit', 'extract', 'align'].includes(r.stage))
  const lastAuditStatus = lastTaskStatus(auditRecords)
  if (lastAuditStatus) progress.lastRunStatus = lastAuditStatus
  for (const record of auditRecords) {
    if (record.status !== 'error' && record.status !== 'budget-exhausted') continue
    classify(record.errorCode, progress)
    failures.push({
      runId: record.runId, stage: 'audit', targetIds: record.targetRefs.map((ref) => ref.id),
      errorCode: record.errorCode ?? 'REVIEW_UNAVAILABLE',
      ...(record.errorDetail ? { errorDetail: record.errorDetail } : {}), endedAt: record.endedAt,
    })
  }
  if (input.artifact) {
    progress.total = 1
    const artifact = input.snapshot.artifacts.find((a) => a.id === input.artifact!.id)
    const digest = auditDependencyDigest(input.snapshot, input.artifact.id, current)
    const matching = auditRecords.filter((r) =>
      r.artifactHash === sha256Hex(input.artifact!.text) && r.contractHash === contractHash &&
      r.policyHash === policyHash() && r.dependencyDigest === digest &&
      r.targetRefs.some((ref) => ref.id === artifact?.id && ref.entityVersion === artifact.entityVersion) &&
      (input.reviewerConfigHash === undefined || r.reviewerConfigHash === input.reviewerConfigHash) &&
      (r.stage === 'audit' ? r.promptHash === '' : r.promptHash === promptHash(r.stage)),
    )
    const latest = [...matching].sort((a, b) => a.endedAt.localeCompare(b.endedAt) || a.runId.localeCompare(b.runId)).at(-1)
    if (latest?.status === 'error' || latest?.status === 'budget-exhausted') progress.failed = 1
    else if (matching.some((align) => align.stage === 'align' && align.status === 'completed' &&
      matching.some((extract) => extract.stage === 'extract' && extract.status === 'completed' &&
        extract.runId === align.runId && extract.inputHash === align.inputHash))) progress.completed = 1
    progress.notRun = progress.total - progress.completed - progress.failed
  }
  failures.sort((a, b) => a.endedAt.localeCompare(b.endedAt) || a.runId.localeCompare(b.runId))
  return { stageProgress, failures }
}
