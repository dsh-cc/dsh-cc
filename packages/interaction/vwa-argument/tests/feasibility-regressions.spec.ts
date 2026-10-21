/** Admission and retry headroom must include work invalidated later in the same run. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { admissionRequestRecord, budgetFeasibilityRefusal, estimateReviewCalls } from '../src/feasibility.ts'
import { executeReviewRun } from '../src/review-runner.ts'
import { ReviewRunStore } from '../src/review-run-store.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import { BUDGET, fakeAdapter, makeArgument, makeClaim, makeSnapshot, makeSource } from './review-helpers.ts'
import type { ReviewStage } from '../src/review-plan.ts'
import type { ReviewCollaborators } from '../src/tools.ts'

async function world(claimsBatchSize = 1, indirect = false) {
  const root = mkdtempSync(join(tmpdir(), 'vwa-feasibility-regression-'))
  const source = makeSource()
  const claims = Array.from({ length: 4 }, () => makeClaim())
  claims.forEach((claim, i) => { claim.scope.corpus = !indirect || i === 0 ? [source.id] : [] })
  // A fifth, independent claim must remain reusable when the source is reviewed.
  const independent = makeClaim()
  const snapshot = makeSnapshot({
    sources: [source], claims: [...claims, independent],
    arguments: indirect ? [makeArgument(independent.id, [claims[1]!.id], [])] : [],
  })
  const budget = { ...BUDGET, concurrency: 1 }
  snapshot.contract.reviewSettings = { budget, claimsBatchSize, maxArtifactChars: 120_000, maxContextChars: 48_000 }
  let retryFailures = false
  const failed = new Set<string>()
  const adapter = fakeAdapter([(req) => {
    const envelope = JSON.parse(req.messages[1]!.content) as {
      stage: string; targets: { id: string }[]; requiredRules: { targetId: string; ruleId: string }[]
    }
    const id = envelope.targets[0]!.id
    if (retryFailures && envelope.stage === 'claims' && claims.slice(0, 2).some((c) => c.id === id) && !failed.has(id)) {
      failed.add(id)
      throw new Error('transient network error')
    }
    return {
      raw: JSON.stringify({
        stage: envelope.stage, rubricVersion: 'humanities-v1', findings: [],
        targets: envelope.targets.map(({ id: targetId }) => ({
          targetId,
          checks: envelope.requiredRules.filter((r) => r.targetId === targetId).map((r) => ({
            ruleId: r.ruleId, result: 'pass', rationale: 'reviewed', evidenceIds: [],
          })),
          ...(envelope.stage === 'claims' ? { searchSufficiency: 'checked' } : {}),
          ...(envelope.stage === 'arguments' ? { adequacy: 'adequate' } : {}),
        })),
      }),
      inputTokens: 1, outputTokens: 1,
    }
  }])
  const input = {
    root, snapshot, adapter, budget, contractHash: sha256Hex(stableJson(snapshot.contract)),
    targetClaimIds: snapshot.claims.map((c) => c.id), stages: ['sources', 'claims'] as ReviewStage[], continueMode: true,
  }
  const first = await executeReviewRun({
    deps: input, snapshot, stages: indirect ? ['claims', 'arguments'] : ['claims'], targetClaimIds: input.targetClaimIds,
    runId: randomUUID(), requestId: randomUUID(), signal: new AbortController().signal,
  })
  expect(first.status).toBe('completed')
  expect(first.calls).toBe(Math.ceil(5 / claimsBatchSize) + (indirect ? 1 : 0))
  return { input, first, claims, independent, failTwoClaims: () => { retryFailures = true } }
}

describe('cross-stage continuation feasibility', () => {
  it.each([1, 2])('counts dependent cached claims with batch size %i but retains independent cache reuse', async (batchSize) => {
    const { input } = await world(batchSize)
    expect(estimateReviewCalls(input)).toMatchObject({
      plannedCalls: { sources: 1, claims: 4 / batchSize },
      estimatedCalls: 1 + 4 / batchSize, estimatedWithRetries: Math.ceil((1 + 4 / batchSize) * 1.5),
    })
  })

  it('propagates invalidation through a cached claim batch even when claims are not requested', async () => {
    const { input } = await world(2, true)
    const stages: ReviewStage[] = ['sources', 'arguments']
    // Source belongs to A, while the argument uses B. A and B share one
    // cached batch: dropping that batch changes the argument's input too.
    expect(estimateReviewCalls({ ...input, stages })).toMatchObject({
      plannedCalls: { sources: 1, claims: 0, arguments: 1 }, estimatedCalls: 2,
    })
    const outcome = await executeReviewRun({
      deps: input, snapshot: input.snapshot, stages, targetClaimIds: input.targetClaimIds,
      runId: randomUUID(), requestId: randomUUID(), continueMode: true, signal: new AbortController().signal,
    })
    expect(outcome.status).toBe('completed')
    expect(outcome.calls).toBe(2)
  })

  it('refuses before admission when the cycle cannot fit invalidated downstream work', async () => {
    const { input, first } = await world()
    expect(budgetFeasibilityRefusal({
      ...input, budget: { ...input.budget, maxCallsPerRun: first.calls + 2 },
      remainingCycleUsed: { calls: first.calls, inputTokens: first.inputTokens, outputTokens: first.outputTokens },
    })).toMatchObject({ code: 'BUDGET_INSUFFICIENT', retryable: false })
  })

  it('gives the admitted continuation enough retry headroom for two transient failures', async () => {
    const { input, failTwoClaims, independent } = await world()
    failTwoClaims()
    const runId = randomUUID()
    const requestId = randomUUID()
    const store = new ReviewRunStore(input.root, input.snapshot.projectId)
    const request = admissionRequestRecord({
      ...input, review: { adapter: input.adapter, budget: input.budget } as ReviewCollaborators,
      body: { continue: true, targetClaimIds: input.targetClaimIds }, runId, requestId, taskId: 'continue', payloadHash: 'test',
    })
    store.writeRequest(runId, request)
    vi.useFakeTimers()
    try {
      const pending = executeReviewRun({
        deps: input, snapshot: input.snapshot, stages: input.stages, targetClaimIds: input.targetClaimIds,
        runId, requestId, continueMode: true, signal: new AbortController().signal,
      })
      await vi.runAllTimersAsync()
      const outcome = await pending
      expect(outcome.status).toBe('completed')
      expect(outcome.refusal).toBeUndefined()
      expect(outcome.calls).toBe(7) // source + four dependent claims + two retries
      expect(request.retryAllowance).toBe(3)
      expect(store.readUsage(runId).filter((r) => r.kind === 'reused')).toHaveLength(1)
      expect(outcome.records.some((r) => r.targetRefs.some((ref) => ref.id === independent.id))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('budget refusal diagnostics', () => {
  it.each(['calls', 'outputTokens', 'both'] as const)('identifies %s exhaustion and includes both limits', async (dimension) => {
    const { input } = await world()
    const estimate = estimateReviewCalls({ ...input, continueMode: false })
    const maxCalls = dimension === 'outputTokens' ? 100 : estimate.estimatedWithRetries - 1
    const maxOutputTokens = dimension === 'calls' ? 1_000_000 : estimate.estimatedOutputTokens - 1
    const refusal = budgetFeasibilityRefusal({
      ...input, continueMode: false,
      budget: { ...input.budget, maxCallsPerRun: maxCalls, maxOutputTokensPerRun: maxOutputTokens },
    })
    const exceededDimensions = dimension === 'both' ? ['calls', 'outputTokens'] : [dimension]
    expect(refusal?.details).toMatchObject({ budgetCalls: maxCalls, budgetOutputTokens: maxOutputTokens, exceededDimensions })
    if (dimension !== 'outputTokens') expect(refusal?.message).toContain(`${estimate.estimatedWithRetries} calls exceed`)
    if (dimension !== 'calls') expect(refusal?.message).toContain(`${estimate.estimatedOutputTokens} output tokens exceed`)
    if (dimension === 'calls') expect(refusal?.message).not.toContain('output tokens exceed')
  })
})
