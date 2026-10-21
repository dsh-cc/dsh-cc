/**
 * Feature C (design docs/plans/2026-10-19-vwa-lane2-feature-c-budget-feasibility.md
 * §C.2.1): static budget feasibility pre-check for `argument.review`, computed
 * BEFORE any request is reserved. The estimate is conservative (reservation
 * upper bound, not the settled actual); the runner still enforces the budget
 * at runtime — this is an early static refusal only.
 *
 * @module @dsh-cc/vwa-argument/feasibility
 */
import { auditCostModel } from './audit-cost.ts'
import { allRecords, planContinueTasks, reusableRecord, resolveTargetClaimIds } from './review-continue.ts'
import type { CycleUsage } from './review-cycle.ts'
import type { ReviewRunStore } from './review-run-store.ts'
import type { Hash } from './types.ts'
import { effectiveAuditUnitChars } from './audit-reuse.ts'
import { fail, type Fail } from './store.ts'
import { sha256Hex, stableJson } from './schema.ts'
import type { ReviewBudget } from './review-budget.ts'
import type { ReviewStage } from './review-plan.ts'
import type { Id, ProjectSnapshot } from './types.ts'
import type { ReviewCollaborators } from './tools.ts'

/** Retry headroom (Feature B): 50% of calls are expected to need one retry (design F1.4 shared contract). */
export const RETRY_ALLOWANCE_FACTOR = 1.5
/** Conservative typical output tokens of one (batched) claims task (§C.2.2). */
const TYPICAL_CLAIM_OUTPUT_TOKENS = 1500

/** §C.2.2: clamp(floor(maxOutputTokensPerCall / 1500), 1, 4). */
export function suggestedClaimsBatchSize(budget: ReviewBudget): number {
  return Math.min(4, Math.max(1, Math.floor(budget.maxOutputTokensPerCall / TYPICAL_CLAIM_OUTPUT_TOKENS)))
}

/** §C.2.1: the full cost estimate (numbers only, no verdict); the refusal in budgetFeasibilityRefusal is layered on top. */
export function estimateReviewCalls(input: {
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
}): {
  plannedCalls: { sources: number; support: number; claims: number; arguments: number; audit: number }
  auditUnits: number
  estimatedCalls: number
  estimatedWithRetries: number
  estimatedOutputTokens: number
  estimatedWallMs: number
} {
  const budget = input.budget
  // Audit calls are ALWAYS counted in full when requested (audit is not
  // incremental — the runner re-executes it whenever `audit` ∈ stages; F1.3).
  // The estimate uses the RUNNER's effective context (48k default), never the
  // runtime's `?? Infinity` fallback (F1.1).
  let auditCalls = 0
  let auditUnits = 0
  if (input.stages.includes('audit') && input.artifact) {
    const unitChars = effectiveAuditUnitChars(
      input.maxContextChars === undefined ? {} : { maxContextChars: input.maxContextChars },
    )
    const model = auditCostModel({
      artifactText: input.artifact.text,
      maxUnitChars: unitChars,
      // The runtime defaults to 48_000 when no caller context is set.
      maxContextChars: input.maxContextChars ?? 48_000,
    })
    auditCalls = model.calls
    auditUnits = model.units
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
  const estimatedWithRetries = Math.ceil(estimatedCalls * RETRY_ALLOWANCE_FACTOR)
  const estimatedOutputTokens = estimatedWithRetries * budget.maxOutputTokensPerCall
  // REPORT-ONLY: the wall is a runtime-only liveness limit (BudgetTracker
  // deadline), never a budget dimension. Order of magnitude: callTimeoutMs
  // per attempt ÷ concurrency. It does NOT gate anything below.
  const estimatedWallMs = Math.ceil((estimatedCalls * budget.callTimeoutMs * 4) / budget.concurrency)
  return { plannedCalls, auditUnits, estimatedCalls, estimatedWithRetries, estimatedOutputTokens, estimatedWallMs }
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
  /** Cycle spend so far (continue mode only); continue gates against the REMAINING cycle budget. */
  remainingCycleUsed?: CycleUsage
}): Fail | undefined {
  const budget = input.budget
  const { plannedCalls, auditUnits, estimatedCalls, estimatedWithRetries, estimatedOutputTokens, estimatedWallMs } =
    estimateReviewCalls(input)
  // Continue mode spends from the CURRENT cycle: compare against the lesser
  // of the frozen per-run budget and the cycle's remaining budget.
  const maxCalls = input.continueMode && input.remainingCycleUsed
    ? Math.min(budget.maxCallsPerRun, Math.max(0, budget.maxCallsPerRun - input.remainingCycleUsed.calls))
    : budget.maxCallsPerRun
  const maxOutputTokens = input.continueMode && input.remainingCycleUsed
    ? Math.min(budget.maxOutputTokensPerRun, Math.max(0, budget.maxOutputTokensPerRun - input.remainingCycleUsed.outputTokens))
    : budget.maxOutputTokensPerRun
  if (estimatedWithRetries <= maxCalls && estimatedOutputTokens <= maxOutputTokens) return undefined
  return fail(
    'BUDGET_INSUFFICIENT',
    `Planned ${estimatedCalls} calls (${estimatedWithRetries} with retry headroom) ≈ ${estimatedOutputTokens} ` +
      `output tokens exceeds the frozen budget of ${maxOutputTokens} (reservation upper bound; ` +
      'actual usage may be lower). Options: (a) reduce target scope, (b) enable claims batching on a new project, ' +
      '(c) create a new project with a larger budget.',
    false,
    {
      plannedCalls,
      auditUnits,
      executableCalls: estimatedCalls,
      estimatedWithRetries,
      estimatedOutputTokens,
      budgetOutputTokens: maxOutputTokens,
      estimatedWallMs,
      budgetWallMs: budget.wallMs,
      suggestedClaimsBatchSize: suggestedClaimsBatchSize(budget),
    },
  )
}

/** F1.4: the per-run retry pool the runtime enforces, from the same estimate the gate reserves. */
export function reviewRetryAllowance(input: {
  root: string
  review: ReviewCollaborators
  snapshot: ProjectSnapshot
  stages: ReviewStage[]
  body: { targetClaimIds?: string[]; continue?: boolean }
  artifact?: { id: Id; text: string }
}): number {
  const { estimatedCalls } = estimateReviewCalls({
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
  return Math.ceil(estimatedCalls * (RETRY_ALLOWANCE_FACTOR - 1))
}

/** F1.4: admission-time request record for `reserveCycleRequest` (retry pool included). */
export function admissionRequestRecord(input: {
  root: string
  review: ReviewCollaborators
  snapshot: ProjectSnapshot
  stages: ReviewStage[]
  body: { targetClaimIds?: string[]; continue?: boolean }
  requestId: string
  runId: Id
  taskId: string
  payloadHash: Hash
  artifact?: { id: Id; text: string }
}): Parameters<ReviewRunStore['writeRequest']>[1] {
  return {
    schemaVersion: 1,
    requestId: input.requestId,
    runId: input.runId,
    stage: input.stages.join('+'),
    targetClaimIds: resolveTargetClaimIds(input.snapshot, input.body),
    payloadHash: input.payloadHash,
    ...(input.body.continue === true ? { continue: true } : {}),
    taskId: input.taskId,
    status: 'queued',
    retryAllowance: reviewRetryAllowance(input),
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    startedAt: new Date().toISOString(),
  }
}

/** Tools-shaped entry point used by argument.review (§C.2.1), before reserving a run. */
export function reviewBudgetRefusal(input: {
  root: string
  review: ReviewCollaborators
  snapshot: ProjectSnapshot
  stages: ReviewStage[]
  body: { targetClaimIds?: string[]; continue?: boolean }
  artifact?: { id: Id; text: string }
  /** Cycle spend so far (continue mode); threads remaining-cycle gating from the caller. */
  remainingCycleUsed?: CycleUsage
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
    ...(input.remainingCycleUsed === undefined ? {} : { remainingCycleUsed: input.remainingCycleUsed }),
  })
}
