/**
 * Public review-envelope constructor, split from review-runner.ts so the
 * runner stays under the file-size budget. Retained for tools inspecting
 * planned inputs; the shape is the persisted task envelope contract.
 *
 * @module @dsh-cc/vwa-argument/review-envelope
 */
import { RUBRIC_VERSION, RULES } from './review-contract.ts'
import type { ReviewStage, ReviewTask } from './review-plan.ts'
import type { Id, ProjectSnapshot } from './types.ts'

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
