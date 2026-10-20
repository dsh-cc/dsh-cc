/**
 * Report stage-level progress and per-task failure detail (Feature D,
 * design docs/plans/2026-10-19-vwa-lane2-feature-d-observability-ux.md
 * §D.2.1–D.2.2). Computed from the FULL record store — failed records are
 * filtered out of currentReviews, so they are invisible there.
 *
 * @module @dsh-cc/vwa-argument/review-progress
 */

import { planStage } from './review-plan.ts'
import type { ReverseIndex } from './dependencies.ts'
import type { Id, ProjectSnapshot, ReviewFailure, ReviewRecord, ReviewStage, StageProgress } from './types.ts'

const PROGRESS_STAGES = ['sources', 'support', 'claims', 'arguments'] as const

// Feature D error classification (§D.2.1). Call timeouts surface as
// REVIEW_UNAVAILABLE (the runner has no separate timeout errorCode literal).
const CHANNEL_CODES = new Set(['REVIEW_UNAVAILABLE', 'REVIEW_TRUNCATED', 'REVIEW_CONFIG_DRIFT'])
const SCHEMA_CODES = new Set(['REVIEW_INVALID'])
const BUDGET_CODES = new Set(['BUDGET_EXHAUSTED', 'CONTEXT_TOO_LARGE'])

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

/** Batched task identity: the sorted ref-id set (same identity the runner signs). */
function refKey(refs: { id: Id }[]): string {
  return refs.map((r) => r.id).sort().join(',')
}

function classify(errorCode: string | undefined, progress: StageProgress): void {
  if (errorCode === undefined) return
  if (CHANNEL_CODES.has(errorCode)) progress.channelErrors += 1
  else if (SCHEMA_CODES.has(errorCode)) progress.schemaErrors += 1
  else if (BUDGET_CODES.has(errorCode)) progress.budgetErrors += 1
}

export function computeStageProgress(input: {
  snapshot: ProjectSnapshot
  index: ReverseIndex
  core: ReadonlySet<Id>
  targets: Id[]
  records: ReviewRecord[]
  claimsBatchSize: number
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
  for (const stage of PROGRESS_STAGES) {
    const progress = stageProgress[stage]
    const stageRecords = records.filter((r) => r.stage === stage)
    if (stageRecords.length > 0) {
      const last = [...stageRecords].sort(
        (a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId),
      ).at(-1)!
      progress.lastRunStatus = last.status
    }
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
      const key = refKey(task.targetRefs)
      const matching = stageRecords.filter((r) => refKey(r.targetRefs) === key)
      const latest = [...matching].sort(
        (a, b) => a.endedAt.localeCompare(b.endedAt) || a.runId.localeCompare(b.runId),
      ).at(-1)
      if (latest?.status === 'error' || latest?.status === 'budget-exhausted') progress.failed += 1
      else if (matching.some((r) => r.status === 'completed')) progress.completed += 1
      else progress.notRun += 1
    }
  }
  failures.sort((a, b) => a.endedAt.localeCompare(b.endedAt) || a.runId.localeCompare(b.runId))
  return { stageProgress, failures }
}
