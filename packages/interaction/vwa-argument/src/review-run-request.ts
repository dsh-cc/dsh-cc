/**
 * Run-request seeding for the review runner, extracted from review-runner.ts
 * (which sits at the file-size budget).
 *
 * @module @dsh-cc/vwa-argument/review-run-request
 */

import type { ReviewRunStore } from './review-run-store.ts'
import type { Id, ReviewJobStatus } from './types.ts'
import type { ReviewStage } from './review-plan.ts'

/** The durable request row seeded at run start (reservation transport fields are merged in later). */
export function seedRunRequest(
  store: ReviewRunStore,
  input: {
    runId: Id
    requestId: string
    stages: ReviewStage[]
    targetClaimIds: Id[]
    artifactId?: Id
    continueMode?: boolean
  },
  startedAt: string,
): ReturnType<ReviewRunStore['readRequest']> & { status: ReviewJobStatus } {
  return {
    ...store.readRequest(input.runId),
    schemaVersion: 1 as const,
    requestId: input.requestId,
    runId: input.runId,
    stage: input.stages.join('+'),
    targetClaimIds: input.targetClaimIds,
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
    ...(input.continueMode ? { continue: true } : {}),
    status: 'running' as ReviewJobStatus,
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    startedAt,
  }
}
