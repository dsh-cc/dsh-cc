/** Frozen batching must be shared by execution, feasibility and continuation. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { semanticContractHash } from '../src/review-contract.ts'
import { describe, expect, it } from 'vitest'
import { budgetFeasibilityRefusal } from '../src/feasibility.ts'
import { continuePreCheck } from '../src/review-continue.ts'
import { executeReviewRun } from '../src/review-runner.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import { BUDGET, NOW, claimsResponse, fakeAdapter, makeClaim, makeSnapshot } from './review-helpers.ts'

function fixture(maxOutputTokensPerRun = 96_000) {
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
    root, snapshot, adapter, budget, contractHash: semanticContractHash(snapshot.contract),
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
    // Three batched calls, five with retry headroom, reserve 15k of 96k.
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

// ---- F1.1/F1.3/F1.5: estimate aligned to runtime semantics (design
// docs/plans/2026-10-21-vwa-feasibility-runtime-alignment.md) ----
import { ReviewRunStore } from '../src/review-run-store.ts'
import { auditCostModel } from '../src/audit-cost.ts'
import { effectiveAuditUnitChars } from '../src/audit-reuse.ts'
import { estimateReviewCalls, RETRY_ALLOWANCE_FACTOR } from '../src/feasibility.ts'

const RUNNER_CONTEXT = 48_000

function auditText(kind: 'small' | 'over-long' | 'mix'): string {
  if (kind === 'small') return Array.from({ length: 20 }, (_, i) => `# H${i}\n\nParagraph ${i} is short.\n`).join('\n')
  if (kind === 'over-long') return `# Big\n\n${'Word sentence. '.repeat(4000)}\n`
  return `# A\n\nShort opening paragraph.\n\n# Big\n\n${'Word sentence. '.repeat(3000)}\n\n# C\n\nClosing paragraph.\n`
}

function auditEstimate(text: string, maxContextChars?: number) {
  return auditCostModel({
    artifactText: text,
    maxUnitChars: effectiveAuditUnitChars(maxContextChars === undefined ? {} : { maxContextChars }),
    maxContextChars: maxContextChars ?? RUNNER_CONTEXT,
    maxOutputTokensPerCall: 3000,
  })
}

describe('audit cost model alignment (F1.1/F1.3)', () => {
  const { input } = fixture()
  const artifactId = 'art_1'
  for (const kind of ['small', 'over-long', 'mix'] as const) {
    it(`matches auditCostModel for ${kind} blocks`, () => {
      const artifact = { id: artifactId, text: auditText(kind) }
      const model = auditEstimate(artifact.text)
      const estimate = estimateReviewCalls({
        ...input, stages: ['claims', 'audit'], artifact, continueMode: false,
      })
      expect(estimate.plannedCalls.audit).toBe(model.calls)
      expect(estimate.auditUnits).toBe(model.units)
      expect(estimate.plannedCalls.audit).toBe(model.extractBatches + model.alignBatches)
      expect(model.calls).toBeGreaterThan(1)
    })
  }

  it('uses the runner’s effective context, never Infinity', () => {
    const artifact = { id: artifactId, text: auditText('mix') }
    // No explicit caller context → runner default 48_000, and the text spans
    // more than one batch at 0.7 × 48_000, so a missing context cannot mean
    // "everything in one batch" (the Infinity fallback).
    const explicit = estimateReviewCalls({ ...input, stages: ['audit'], artifact, maxContextChars: RUNNER_CONTEXT, continueMode: false })
    const defaulted = estimateReviewCalls({ ...input, stages: ['audit'], artifact, continueMode: false })
    expect(defaulted.plannedCalls.audit).toBe(explicit.plannedCalls.audit)
    expect(defaulted.plannedCalls.audit).toBeGreaterThanOrEqual(2)
    // A small enforced context packs tighter: strictly more calls.
    const tight = estimateReviewCalls({ ...input, stages: ['audit'], artifact, maxContextChars: 2_000, continueMode: false })
    expect(tight.plannedCalls.audit).toBeGreaterThan(defaulted.plannedCalls.audit)
  })

  it('counts audit in full in continue mode even when an old audit record exists', () => {
    const artifact = { id: artifactId, text: auditText('small') }
    const base = { ...input, stages: ['audit'] as const, artifact, continueMode: true }
    const before = estimateReviewCalls(base)
    // A completed audit record from a prior run must not zero the estimate:
    // remaining semantic work can still change the audit dependency digest (F1.3).
    const store = new ReviewRunStore(input.root, input.snapshot.projectId)
    store.writeRecord('run_prior', {
      runId: 'run_prior', stage: 'audit', status: 'completed', inputHash: 'hash_old',
      createdAt: NOW, response: {},
    } as never)
    expect(estimateReviewCalls(base).plannedCalls.audit).toBe(before.plannedCalls.audit)
    expect(before.plannedCalls.audit).toBeGreaterThan(0)
  })
})

describe('retry allowance, per-dimension gating and remaining-cycle budget (F1.5)', () => {
  const { input } = fixture()
  const stages = ['claims'] as const
  const estimate = estimateReviewCalls({ ...input, stages: [...stages], continueMode: false })

  it('applies the shared retry allowance factor', () => {
    expect(RETRY_ALLOWANCE_FACTOR).toBe(1.5)
    expect(estimate.estimatedWithRetries).toBe(Math.ceil(estimate.estimatedCalls * RETRY_ALLOWANCE_FACTOR))
  })

  it('refuses on maxCallsPerRun even when output tokens fit', () => {
    const budget = { ...input.budget, maxCallsPerRun: estimate.estimatedWithRetries - 1 }
    const refusal = budgetFeasibilityRefusal({ ...input, stages: [...stages], budget, continueMode: false })
    expect(refusal).toMatchObject({ code: 'BUDGET_INSUFFICIENT', retryable: false })
  })

  it('gates continue mode against the remaining cycle budget', () => {
    // Fresh-cycle headroom: fits.
    expect(budgetFeasibilityRefusal({ ...input, stages: [...stages], continueMode: true })).toBeUndefined()
    // Prior runs in the cycle already spent most of it → the same plan refuses.
    const used = { calls: 0, inputTokens: 0, outputTokens: input.budget.maxOutputTokensPerRun - estimate.estimatedOutputTokens + 1 }
    const refusal = budgetFeasibilityRefusal({ ...input, stages: [...stages], continueMode: true, remainingCycleUsed: used })
    expect(refusal).toMatchObject({ code: 'BUDGET_INSUFFICIENT', retryable: false })
  })

  it('reports the wall without gating on it', () => {
    // A microscopic wall does NOT refuse; the wall is a runtime-only liveness limit.
    const budget = { ...input.budget, wallMs: 1 }
    expect(budgetFeasibilityRefusal({ ...input, stages: [...stages], budget, continueMode: false })).toBeUndefined()
    // But the wall number is still reported in any refusal detail.
    const refusing = budgetFeasibilityRefusal({
      ...input, stages: [...stages],
      budget: { ...input.budget, maxOutputTokensPerRun: estimate.estimatedOutputTokens - 1 },
      continueMode: false,
    })
    expect(refusing?.details).toMatchObject({
      estimatedWallMs: estimate.estimatedWallMs,
      budgetWallMs: input.budget.wallMs,
    })
  })
})

