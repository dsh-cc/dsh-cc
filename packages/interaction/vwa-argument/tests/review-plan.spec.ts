/**
 * Claims batching tests (Feature C §C.2.2): batch size >1 groups consecutive
 * claim tasks; batch size 1/absent keeps the single-claim envelope shape.
 */

import { describe, expect, it } from 'vitest'
import { buildReverseIndex } from '../src/dependencies.ts'
import { planStage } from '../src/review-plan.ts'
import { makeClaim, makeSnapshot, NOW, uuid } from './review-helpers.ts'

function searchFor(claimId: string) {
  return {
    id: `sch_${uuid()}`, entityVersion: 1, createdAt: NOW, updatedAt: NOW,
    purpose: 'search sufficiency', targetIds: [claimId], corpus: [],
    query: 'counterexamples', tool: 'grep', performedAt: NOW,
    state: 'executed' as const, resultSourceIds: [], inaccessible: [],
    finding: 'none-found' as const,
  }
}

function claimSnapshot(count: number) {
  const claims = Array.from({ length: count }, (_, i) => makeClaim('fact', `Claim ${i} holds.`))
  const searches = claims.map((claim) => searchFor(claim.id))
  return { snapshot: makeSnapshot({ claims, searches }), claims }
}

describe('planStage claims batching (Feature C §C.2.2)', () => {
  it('groups 6 claims into 2 tasks with batch size 3', () => {
    const { snapshot, claims } = claimSnapshot(6)
    const tasks = planStage({
      stage: 'claims', snapshot, index: buildReverseIndex(snapshot),
      targetClaimIds: claims.map((c) => c.id), core: new Set(), claimsBatchSize: 3,
    })
    expect(tasks).toHaveLength(2)
    const ids = tasks.flatMap((t) => t.targetIds)
    expect([...ids].sort()).toEqual([...claims.map((c) => c.id)].sort())
    for (const task of tasks) {
      const envelope = task.envelope as { targets: unknown[]; searches: unknown[] }
      expect(Array.isArray(envelope.targets)).toBe(true)
      expect(envelope.targets).toHaveLength(3)
      expect(envelope.searches).toHaveLength(3)
      expect(task.targetRefs).toHaveLength(3)
    }
    // requiredRules cover every batched claim
    for (const task of tasks) {
      for (const ref of task.targetRefs) {
        expect(task.requiredRules.some((r) => r.targetId === ref.id)).toBe(true)
      }
    }
  })

  it('keeps the single-claim envelope shape for batch size 1 and absent (regression pin)', () => {
    const { snapshot, claims } = claimSnapshot(2)
    const index = buildReverseIndex(snapshot)
    const base = { stage: 'claims' as const, snapshot, index, targetClaimIds: claims.map((c) => c.id), core: new Set() }
    for (const input of [base, { ...base, claimsBatchSize: 1 }]) {
      const tasks = planStage(input)
      expect(tasks).toHaveLength(2)
      for (const task of tasks) {
        const envelope = task.envelope as { target: unknown; searches: unknown[] }
        expect('target' in envelope).toBe(true)
        expect(Array.isArray(envelope.searches)).toBe(true)
      }
    }
  })
})
