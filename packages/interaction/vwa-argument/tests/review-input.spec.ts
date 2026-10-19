/**
 * Slice-1 spec: semantic record hashing and deduplication (§A.3.3) and the
 * taskDependencyDigest stability guarantee under record reuse.
 * @module tests/review-input
 */

import { describe, expect, it } from 'vitest'
import { buildReverseIndex } from '../src/dependencies.ts'
import { deduplicateBySemanticHash, semanticRecordHash, taskDependencyDigest } from '../src/review-input.ts'
import { planStage } from '../src/review-plan.ts'
import type { ReviewRecord, SemanticReviewRecord } from '../src/types.ts'
import { makeClaim, makeEvidence, makeGroup, makeSnapshot, makeSource, NOW } from './review-helpers.ts'

function makeRecord(overrides: Partial<SemanticReviewRecord> = {}): SemanticReviewRecord {
  return {
    runId: 'run_a',
    stage: 'sources',
    targetRefs: [{ id: 'src_x', entityVersion: 1 }],
    dependencyDigest: 'd'.repeat(64),
    contractHash: 'c'.repeat(64),
    policyHash: 'p'.repeat(64),
    reviewerConfigHash: 'r'.repeat(64),
    promptHash: 'm'.repeat(64),
    inputHash: 'i'.repeat(64),
    status: 'completed',
    inputTokens: 100,
    outputTokens: 50,
    startedAt: NOW,
    endedAt: NOW,
    ...overrides,
  }
}

describe('semanticRecordHash (§A.3.3)', () => {
  it('is invariant to run metadata: runId, timestamps, kind, errorCode, token counts', () => {
    const base = makeRecord()
    const copy = makeRecord({
      runId: 'run_other',
      startedAt: '2026-10-17T00:00:00.000Z',
      endedAt: '2026-10-18T00:00:00.000Z',
      kind: 'disagreement',
      errorCode: 'TIMEOUT',
      inputTokens: 999,
      outputTokens: 888,
    })
    expect(semanticRecordHash(copy as ReviewRecord)).toBe(semanticRecordHash(base as ReviewRecord))
  })

  it('changes when semantic content (status, response) differs', () => {
    expect(semanticRecordHash(makeRecord({ status: 'error' }) as ReviewRecord)).not.toBe(
      semanticRecordHash(makeRecord() as ReviewRecord),
    )
  })
})

describe('deduplicateBySemanticHash (§A.3.3)', () => {
  it('collapses semantically identical records (original + reused copy)', () => {
    const original = makeRecord()
    const copy = makeRecord({ runId: 'run_next', inputTokens: 0, outputTokens: 0 })
    const other = makeRecord({ targetRefs: [{ id: 'src_y', entityVersion: 1 }], inputHash: 'f'.repeat(64) })
    const out = deduplicateBySemanticHash([original, copy, other].map((r) => r as ReviewRecord))
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(original)
  })
})

describe('taskDependencyDigest under record reuse (§A.3.3)', () => {
  it('is unchanged when a reused copy of an upstream record is added', () => {
    const claim = makeClaim('fact')
    const source = makeSource()
    const evidence = makeEvidence(source)
    const snapshot = makeSnapshot({
      sources: [source],
      evidence: [evidence],
      claims: [{ ...claim, scope: { ...claim.scope, corpus: [source.id] } }],
      groups: [makeGroup(claim.id, [evidence.id])],
    })
    const index = buildReverseIndex(snapshot)
    const task = planStage({ stage: 'claims', snapshot, index, targetClaimIds: [claim.id], core: new Set() })[0]!
    expect(task).toBeDefined()
    const sourceHash = 'a'.repeat(64)
    const original = makeRecord({
      stage: 'sources',
      targetRefs: [{ id: source.id, entityVersion: source.entityVersion }],
      contractHash: sourceHash,
    })
    // Reuse copy: same semantic content, new runId and run timestamps.
    const copy = makeRecord({
      stage: 'sources',
      targetRefs: [{ id: source.id, entityVersion: source.entityVersion }],
      contractHash: sourceHash,
      runId: 'run_next',
      startedAt: '2026-10-17T00:00:00.000Z',
      endedAt: '2026-10-18T00:00:00.000Z',
      inputTokens: 0,
      outputTokens: 0,
    })
    const digest = taskDependencyDigest(index, task, [original as ReviewRecord])
    expect(taskDependencyDigest(index, task, [original, copy] as ReviewRecord[])).toBe(digest)
  })
})
