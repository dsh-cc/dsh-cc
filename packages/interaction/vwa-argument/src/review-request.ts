/** Replay a reserved review request without initializing or dispatching a model. */
import { fail, type Fail } from './store.ts'
import type { ReviewRunStore } from './review-run-store.ts'
import type { Hash, Id } from './types.ts'
import type { JsonValue } from './schema.ts'

export function replayReviewRequest(input: {
  store: ReviewRunStore
  requestId: string
  payloadHash: Hash
  projectId: Id
  revision: number
}) {
  const { store } = input
  const existing = store.findRunByRequestId(input.requestId)
  if (existing === undefined) return undefined
  if (existing.payloadHash !== undefined && existing.payloadHash !== input.payloadHash)
    return fail('IDEMPOTENCY_CONFLICT', 'requestId was used with a different review payload')
  const outcome = store.readOutcome(existing.runId)
  // A run that refused to execute replays its refusal, never an empty review.
  const refusal = (outcome as { refusal?: Fail } | undefined)?.refusal
  if (refusal?.ok === false) return fail(refusal.code, refusal.message, refusal.retryable, { runId: existing.runId })
  return {
    ok: true as const,
    projectId: input.projectId,
    revision: input.revision,
    data: existing.status === 'running' || existing.status === 'queued'
      ? { completion: 'running' as const, runId: existing.runId, taskId: existing.taskId ?? existing.runId }
      : {
          completion: existing.status === 'completed' ? 'completed' as const : 'incomplete' as const,
          status: existing.status,
          runId: existing.runId,
          records: store.readRecords(existing.runId) as unknown as JsonValue[],
          ...(outcome === undefined ? {} : { result: outcome as JsonValue }),
          usage: { calls: existing.calls, inputTokens: existing.inputTokens, outputTokens: existing.outputTokens },
        },
  }
}
