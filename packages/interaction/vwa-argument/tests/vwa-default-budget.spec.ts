/**
 * Fix 2 regression pin (design
 * docs/plans/2026-10-21-vwa-default-budget-rebalance.md §3): the SHIP DEFAULT
 * frozen budget (96 000 output tokens/run, 40 calls, per-call 3 000, batch 1)
 * must admit a minimal complete `stage:"all"` review, refuse a 10-claim
 * batch-1 graph with the batching escape, and admit the same graph at
 * claims batch 2.
 */
import { describe, expect, it } from 'vitest'
import { budgetFeasibilityRefusal } from '../src/feasibility.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import { DEFAULT_VWA_ARGUMENT_SETTINGS } from '../src/settings.ts'
import {
  fakeAdapter, makeArgument, makeClaim, makeGroup, makeSnapshot, makeSource,
} from './review-helpers.ts'
import { freezeReviewSettings } from '../src/review-config.ts'
import type { ReviewStage } from '../src/review-plan.ts'

const FROZEN = freezeReviewSettings()
// tools.ts ALL_ORDER: the complete review's stage order.
const STAGES: ReviewStage[] = ['sources', 'support', 'claims', 'arguments', 'audit']

/** A small artifact text that costs exactly 2 audit calls (1 extract batch + 1 align). */
const ARTIFACT = { id: 'art_1', text: Array.from({ length: 20 }, (_, i) => `# H${i}\n\nParagraph ${i} is short.\n`).join('\n') }

/** The minimal complete graph: 1 source, 1 group, 1 claim, 1 argument (+2 audit = 6 first attempts). */
function minimalGraph() {
  const source = makeSource()
  const claim = makeClaim()
  const group = makeGroup(claim.id, [source.id])
  const snapshot = makeSnapshot({
    sources: [source], claims: [claim], groups: [group],
    arguments: [makeArgument(claim.id, [claim.id], [group.id])],
  })
  return { snapshot, targetClaimIds: [claim.id] }
}

function tenClaimGraph(batchSize?: number) {
  const sources = Array.from({ length: 5 }, () => makeSource())
  const claims = Array.from({ length: 10 }, () => makeClaim())
  const groups = claims.map((c) => makeGroup(c.id, [sources[0]!.id]))
  const arguments_ = Array.from({ length: 3 }, (_, i) => makeArgument(claims[i]!.id, [claims[(i + 1) % 10]!.id], [groups[i]!.id]))
  const snapshot = makeSnapshot({ sources, claims, groups, arguments: arguments_ })
  if (batchSize !== undefined) {
    snapshot.contract.reviewSettings = { ...freezeReviewSettings({ ...DEFAULT_VWA_ARGUMENT_SETTINGS, 'review-claims-batch-size': batchSize }) }
  }
  return { snapshot, targetClaimIds: claims.map((c) => c.id) }
}

function inputFor(snapshot: ReturnType<typeof tenClaimGraph>['snapshot'], targetClaimIds: string[]) {
  return {
    root: '/nonexistent', snapshot, adapter: fakeAdapter([]), budget: FROZEN.budget,
    contractHash: sha256Hex(stableJson(snapshot.contract)), stages: STAGES,
    targetClaimIds, artifact: ARTIFACT, continueMode: false,
  }
}

describe('default frozen budget (Fix 2 regression pin)', () => {
  it('pins the new ship defaults', () => {
    expect(FROZEN.budget.maxOutputTokensPerRun).toBe(96_000)
    expect(FROZEN.budget.wallMs).toBe(900_000)
    expect(FROZEN.claimsBatchSize).toBe(1)
  })

  it('admits a minimal complete stage:"all" review under pure defaults', () => {
    const { snapshot, targetClaimIds } = minimalGraph()
    // 1 sources + 1 support + 1 claims + 1 arguments + 2 audit = 6 first
    // attempts → 9 with retry headroom × 3 000 = 27 000 ≤ 96 000.
    const estimate = budgetFeasibilityRefusal(inputFor(snapshot, targetClaimIds))
    expect(estimate).toBeUndefined()
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
})
