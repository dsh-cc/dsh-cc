/**
 * Feature C (design docs/plans/2026-10-19-vwa-lane2-feature-c-budget-feasibility.md
 * §C.2.1): static budget feasibility pre-check for `argument.review`, computed
 * BEFORE any request is reserved. The estimate is conservative (reservation
 * upper bound, not the settled actual); the runner still enforces the budget
 * at runtime — this is an early static refusal only.
 *
 * @module @dsh-cc/vwa-argument/feasibility
 */
import { allRecords, planContinueTasks, reusableRecord, resolveTargetClaimIds } from './review-continue.ts'
import { rootBlocks } from './markdown-blocks.ts'
import { stripClaimMarkers } from './audit-input.ts'
import { effectiveAuditUnitChars } from './audit-reuse.ts'
import { fail, type Fail } from './store.ts'
import { sha256Hex, stableJson } from './schema.ts'
import type { ReviewBudget } from './review-budget.ts'
import type { ReviewStage } from './review-plan.ts'
import type { Id, ProjectSnapshot } from './types.ts'
import type { ReviewCollaborators } from './tools.ts'

/** Retry headroom (Feature B): 50% of calls are expected to need one retry. */
const RETRY_FACTOR = 1.5
/** Conservative typical output tokens of one (batched) claims task (§C.2.2). */
const TYPICAL_CLAIM_OUTPUT_TOKENS = 1500

/** §C.2.2: clamp(floor(maxOutputTokensPerCall / 1500), 1, 4). */
export function suggestedClaimsBatchSize(budget: ReviewBudget): number {
  return Math.min(4, Math.max(1, Math.floor(budget.maxOutputTokensPerCall / TYPICAL_CLAIM_OUTPUT_TOKENS)))
}

/** §C.2.1: undefined when the plan plausibly fits the frozen budget; otherwise BUDGET_INSUFFICIENT. */
export function budgetFeasibilityRefusal(input: {
  root: string
  snapshot: ProjectSnapshot
  stages: ReviewStage[]
  targetClaimIds: Id[]
  artifact?: { id: Id; text: string }
  maxContextChars?: number
  budget: ReviewBudget
  contractHash: string
  adapter: Pick<import('./review-adapter.ts').ReviewModelAdapter, 'configFingerprint'>
  continueMode: boolean
}): Fail | undefined {
  const budget = input.budget
  // Audit calls are ALWAYS counted in full when requested (audit is not incremental).
  let auditCalls = 0
  if (input.stages.includes('audit') && input.artifact) {
    const unitChars = effectiveAuditUnitChars(
      input.maxContextChars === undefined ? {} : { maxContextChars: input.maxContextChars },
    )
    const rootBlockCount = rootBlocks(stripClaimMarkers(input.artifact.text).text).length
    const estimatedUnits = rootBlockCount + Math.ceil(input.artifact.text.length / unitChars)
    auditCalls = estimatedUnits + 1
  }
  // Per-stage executable counts. Fresh runs count every planned task; in
  // continue mode only tasks WITHOUT a reusable completed record (the same
  // reuse semantics the runner applies), while audit stays counted in full.
  const history = allRecords(input.root, input.snapshot.projectId)
  const plannedCalls = { sources: 0, support: 0, claims: 0, arguments: 0, audit: auditCalls }
  let executableTasks = 0
  for (const { stage, task, inputHash } of planContinueTasks({
    root: input.root,
    adapter: input.adapter,
    contractHash: input.contractHash,
    snapshot: input.snapshot,
    stages: input.stages.filter((s) => s !== 'audit'),
    targetClaimIds: input.targetClaimIds,
    ...(input.artifact ? { artifact: input.artifact } : {}),
    history,
  })) {
    if (input.continueMode) {
      const prior = history.filter((r) => r.inputHash === inputHash)
      if (reusableRecord(prior, task, true, new Set()) !== undefined) continue
    }
    plannedCalls[stage] += 1
    executableTasks += 1
  }
  const estimatedCalls = executableTasks + auditCalls
  const estimatedWithRetries = Math.ceil(estimatedCalls * RETRY_FACTOR)
  const estimatedOutputTokens = estimatedWithRetries * budget.maxOutputTokensPerCall
  // Conservative wall ceiling: every call takes the maximum 4x per-call timeout (§B.2.3).
  const estimatedWallMs = Math.ceil((estimatedCalls * budget.callTimeoutMs * 4) / budget.concurrency)
  if (estimatedOutputTokens <= budget.maxOutputTokensPerRun) return undefined
  return fail(
    'BUDGET_INSUFFICIENT',
    `Planned ${estimatedCalls} calls (${estimatedWithRetries} with retry headroom) ≈ ${estimatedOutputTokens} ` +
      `output tokens exceeds the frozen budget of ${budget.maxOutputTokensPerRun} (reservation upper bound; ` +
      'actual usage may be lower). Options: (a) reduce target scope, (b) enable claims batching on a new project, ' +
      '(c) create a new project with a larger budget.',
    false,
    {
      plannedCalls,
      executableCalls: estimatedCalls,
      estimatedWithRetries,
      estimatedOutputTokens,
      budgetOutputTokens: budget.maxOutputTokensPerRun,
      estimatedWallMs,
      budgetWallMs: budget.wallMs,
      suggestedClaimsBatchSize: suggestedClaimsBatchSize(budget),
    },
  )
}

/** Tools-shaped entry point used by argument.review (§C.2.1), before reserving a run. */
export function reviewBudgetRefusal(input: {
  root: string
  review: ReviewCollaborators
  snapshot: ProjectSnapshot
  stages: ReviewStage[]
  body: { targetClaimIds?: string[]; continue?: boolean }
  artifact?: { id: Id; text: string }
}): Fail | undefined {
  return budgetFeasibilityRefusal({
    root: input.root,
    snapshot: input.snapshot,
    stages: input.stages,
    targetClaimIds: resolveTargetClaimIds(input.snapshot, input.body),
    ...(input.artifact ? { artifact: input.artifact } : {}),
    ...(input.review.maxContextChars ? { maxContextChars: input.review.maxContextChars } : {}),
    budget: input.review.budget,
    contractHash: sha256Hex(stableJson(input.snapshot.contract)),
    adapter: input.review.adapter,
    continueMode: input.body.continue === true,
  })
}
