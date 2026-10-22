/**
 * Fix 2 regression pin (design
 * docs/plans/2026-10-21-vwa-default-budget-rebalance.md §3): the SHIP DEFAULT
 * frozen budget (96 000 output tokens/run, 40 calls, per-call 3 000, batch 1)
 * must admit a minimal complete `stage:"all"` review, refuse a 10-claim
 * batch-1 graph with the batching escape, and admit the same graph at
 * claims batch 2.
 */
import { semanticContractHash } from '../src/review-contract.ts'
import { describe, expect, it } from 'vitest'
import { budgetFeasibilityRefusal, estimateReviewCalls } from '../src/feasibility.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import { DEFAULT_VWA_ARGUMENT_SETTINGS } from '../src/settings.ts'
import {
  fakeAdapter, makeArgument, makeClaim, makeEvidence, makeGroup, makeSnapshot, makeSource,
} from './review-helpers.ts'
import { freezeReviewSettings } from '../src/review-config.ts'
import type { ReviewStage } from '../src/review-plan.ts'

const FROZEN = freezeReviewSettings()
// tools.ts ALL_ORDER: the complete review's stage order.
const STAGES: ReviewStage[] = ['sources', 'support', 'claims', 'arguments', 'audit']

/** A small artifact text that costs exactly 2 audit calls (1 extract batch + 1 align). */
const ARTIFACT = { id: 'art_1', text: Array.from({ length: 20 }, (_, i) => `# H${i}\n\nParagraph ${i} is short.\n`).join('\n') }

/** The minimal complete graph: 1 source + 1 evidence + 1 group + 1 claim + 1 argument (+2 audit = 6 first attempts). */
function minimalGraph() {
  const source = makeSource()
  const evidence = makeEvidence(source)
  const claim = makeClaim()
  const group = makeGroup(claim.id, [evidence.id])
  const snapshot = makeSnapshot({
    sources: [source], evidence: [evidence], claims: [claim], groups: [group],
    // Deliberate self-premise: claimClosure() pulls premise claims into the
    // closure, so a distinct premise would plan a second claims call and
    // change the documented minimal-graph arithmetic (6 first attempts).
    arguments: [makeArgument(claim.id, [claim.id], [group.id])],
  })
  return { snapshot, targetClaimIds: [claim.id] }
}

function tenClaimGraph(batchSize?: number) {
  // 5 sources (each linked through real evidence), 5 support groups, 10
  // claims, 3 arguments: 5 + 5 + 10 + 3 + 2 audit = 25 first attempts.
  const sources = Array.from({ length: 5 }, () => makeSource())
  const evidence = sources.map((s) => makeEvidence(s))
  const claims = Array.from({ length: 10 }, () => makeClaim())
  // Five groups cover the first five claims; the other five claims plan
  // claims-stage tasks without a support group (per-claim review).
  const groups = claims.slice(0, 5).map((c, i) => makeGroup(c.id, [evidence[i]!.id]))
  const arguments_ = Array.from({ length: 3 }, (_, i) => makeArgument(claims[i]!.id, [claims[(i + 1) % 10]!.id], [groups[i % 5]!.id]))
  const snapshot = makeSnapshot({ sources, evidence, claims, groups, arguments: arguments_ })
  if (batchSize !== undefined) {
    snapshot.contract.reviewSettings = { ...freezeReviewSettings({ ...DEFAULT_VWA_ARGUMENT_SETTINGS, 'review-claims-batch-size': batchSize }) }
  }
  return { snapshot, targetClaimIds: claims.map((c) => c.id) }
}

function inputFor(snapshot: ReturnType<typeof tenClaimGraph>['snapshot'], targetClaimIds: string[]) {
  return {
    root: '/nonexistent', snapshot, adapter: fakeAdapter([]), budget: FROZEN.budget,
    contractHash: semanticContractHash(snapshot.contract), stages: STAGES,
    targetClaimIds, artifact: ARTIFACT, continueMode: false,
  }
}

describe('default frozen budget (Fix 2 regression pin)', () => {
  it('pins the new ship defaults', () => {
    expect(FROZEN.budget.maxOutputTokensPerRun).toBe(96_000)
    expect(FROZEN.budget.wallMs).toBe(900_000)
    expect(FROZEN.claimsBatchSize).toBe(1)
  })

  it('plans the minimal complete graph per stage: 1 source + 1 support + 1 claim + 1 argument + 2 audit', () => {
    const { snapshot, targetClaimIds } = minimalGraph()
    const estimate = estimateReviewCalls(inputFor(snapshot, targetClaimIds))
    // Per-stage pins: the sources stage must actually plan the linked source
    // (evidence-linked corpus), not silently skip it.
    expect(estimate.plannedCalls).toEqual({ sources: 1, support: 1, claims: 1, arguments: 1, audit: 2 })
    expect(estimate.estimatedCalls).toBe(6)
  })

  it('admits a minimal complete stage:"all" review under pure defaults', async () => {
    const { snapshot, targetClaimIds } = minimalGraph()
    // 1 sources + 1 support + 1 claims + 1 arguments + 2 audit = 6 first
    // attempts → 9 with retry headroom × 3 000 = 27 000 ≤ 96 000.
    const estimate = budgetFeasibilityRefusal(inputFor(snapshot, targetClaimIds))
    expect(estimate).toBeUndefined()
  })

  it('plans the 10-claim graph per stage: 5 sources + 5 support + 10 claims + 3 arguments + 2 audit', () => {
    const { snapshot, targetClaimIds } = tenClaimGraph()
    const estimate = estimateReviewCalls(inputFor(snapshot, targetClaimIds))
    // Per-stage pins guard against composition drift (e.g. sources dropping
    // out while support grows to compensate — equal totals masked exactly
    // that in the first version of this spec).
    expect(estimate.plannedCalls).toEqual({ sources: 5, support: 5, claims: 10, arguments: 3, audit: 2 })
    expect(estimate.estimatedCalls).toBe(25)
  })

  it('refuses a 10-claim batch-1 graph on the output-token dimension only', () => {
    const { snapshot, targetClaimIds } = tenClaimGraph()
    const refusal = budgetFeasibilityRefusal(inputFor(snapshot, targetClaimIds))
    expect(refusal).toMatchObject({ code: 'BUDGET_INSUFFICIENT', retryable: false })
    expect(refusal?.details).toMatchObject({ estimatedWithRetries: 38, estimatedOutputTokens: 114_000 })
    expect((refusal?.details as Record<string, unknown>).exceededDimensions).toEqual(['outputTokens'])
    // 38 attempts fit the 40-call budget; only tokens refuse.
    expect(refusal?.message).toContain('output token')
    expect(refusal?.message).toContain('exceeds the frozen budget on')
    expect(refusal?.message).toContain('review scope (targetClaimIds / stage)')
    expect(refusal?.message).toContain('BEFORE creating a project')
    expect(refusal?.message).toContain('are NOT carried over')
    expect((refusal?.details as Record<string, unknown>).suggestedClaimsBatchSize).toBe(2)
  })

  it('admits the same 10-claim graph at claims batch 2', () => {
    const { snapshot, targetClaimIds } = tenClaimGraph(2)
    // 5 + 5 + 5 batched claims + 3 + 2 = 20 first attempts → 30 × 3 000 = 90 000 ≤ 96 000.
    expect(budgetFeasibilityRefusal(inputFor(snapshot, targetClaimIds))).toBeUndefined()
  })

  it('names review-max-calls-per-run when the refusal is calls-bound', () => {
    // A calls-bound refusal: 38 attempts against a 10-call budget with tokens
    // plentiful. Raising the OUTPUT-token budget or the claims batch size
    // cannot fix a calls-bound refusal, so the guidance must name the call
    // budget setting.
    const { snapshot, targetClaimIds } = tenClaimGraph()
    const callsBound = budgetFeasibilityRefusal({
      ...inputFor(snapshot, targetClaimIds),
      budget: { ...FROZEN.budget, maxCallsPerRun: 10, maxOutputTokensPerRun: 1_000_000 },
    })
    expect(callsBound).toMatchObject({ code: 'BUDGET_INSUFFICIENT', retryable: false })
    expect((callsBound?.details as Record<string, unknown>).exceededDimensions).toEqual(['calls'])
    expect(callsBound?.message).toContain('review-max-calls-per-run')
    expect(callsBound?.message).toContain('BEFORE creating a project')
    // A tokens-bound-only refusal keeps the token-budget guidance.
    const tokensBound = budgetFeasibilityRefusal(inputFor(snapshot, targetClaimIds))
    expect(tokensBound?.message).toContain('review-max-output-tokens-per-run')
  })
})
