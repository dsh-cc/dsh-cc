/** Frozen batching must be shared by execution, feasibility and continuation. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { budgetFeasibilityRefusal } from '../src/feasibility.ts'
import { continuePreCheck } from '../src/review-continue.ts'
import { executeReviewRun } from '../src/review-runner.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import { BUDGET, claimsResponse, fakeAdapter, makeClaim, makeSnapshot } from './review-helpers.ts'

function fixture(maxOutputTokensPerRun = 24_000) {
  const root = mkdtempSync(join(tmpdir(), 'vwa-feasibility-'))
  const claims = Array.from({ length: 6 }, () => makeClaim())
  const budget = { ...BUDGET, maxOutputTokensPerRun }
  const snapshot = makeSnapshot({ claims })
  snapshot.contract.reviewSettings = {
    budget, maxArtifactChars: 120_000, maxContextChars: 48_000, claimsBatchSize: 2,
  }
  const adapter = fakeAdapter([(req) => {
    const envelope = JSON.parse(req.messages[1]!.content) as { targets: { id: string }[] }
    return {
      raw: claimsResponse(claims[0]!.id, 'pass', {
        targets: envelope.targets.map(({ id }) => ({
          targetId: id, searchSufficiency: 'checked',
          checks: [{ ruleId: 'HIST-01', result: 'pass', rationale: 'reviewed', evidenceIds: [] }],
        })),
      }),
      inputTokens: 10, outputTokens: 10,
    }
  }])
  const input = {
    root, snapshot, adapter, budget, contractHash: sha256Hex(stableJson(snapshot.contract)),
    stages: ['claims' as const], targetClaimIds: claims.map((c) => c.id),
  }
  const run = (targetClaimIds = input.targetClaimIds) => executeReviewRun({
    deps: input, snapshot, stages: input.stages, targetClaimIds,
    runId: `run_${randomUUID()}`, requestId: randomUUID(), signal: new AbortController().signal,
  })
  return { input, run }
}

describe('batched budget feasibility and continuation', () => {
  it('admits six claims as three calls under the default output budget', () => {
    const { input } = fixture()
    // Three batched calls, five with retry headroom, reserve 15k of 24k.
    expect(budgetFeasibilityRefusal({ ...input, continueMode: false })).toBeUndefined()
  })

  it('exempts completed batches when estimating a continuation', async () => {
    const { input, run } = fixture(6000)
    const first = await run(input.targetClaimIds.slice(0, 4))
    expect(first.status).toBe('completed')
    expect(first.calls).toBe(2)
    // One remaining batch fits exactly with retry headroom; counting all
    // three batches would reserve 15k and incorrectly reject this request.
    expect(budgetFeasibilityRefusal({ ...input, continueMode: true })).toBeUndefined()
  })

  it('refuses a fully completed batched plan as NOTHING_TO_CONTINUE', async () => {
    const { input, run } = fixture()
    expect((await run()).status).toBe('completed')
    expect(continuePreCheck(input)).toMatchObject({ code: 'NOTHING_TO_CONTINUE', retryable: false })
  })
})
