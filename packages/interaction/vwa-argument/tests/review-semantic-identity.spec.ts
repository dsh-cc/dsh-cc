/**
 * F3.1 — one identity policy: the semantic contract hash (contract minus
 * `reviewSettings`) everywhere identity is computed or compared. Capacity
 * changes must preserve completed-record reuse; semantic contract changes
 * must still invalidate (§F3.1 of docs/plans/2026-10-21-vwa-review-settings-revision.md).
 * @module tests/review-semantic-identity
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { recordMatchesKey, semanticContract, semanticContractHash } from '../src/review-contract.ts'
import { auditDependencyDigest, matchesReviewTask } from '../src/review-current.ts'
import { collectCachedRecords } from '../src/review-continue.ts'
import { findReusableAudit, hasReusableAudit, AUDIT_RULE_IDS } from '../src/audit-reuse.ts'
import { ReviewRunStore } from '../src/review-run-store.ts'
import { makeSnapshot } from './review-helpers.ts'
import type { ReviewRecord } from '../src/types.ts'

const baseSnapshot = () => makeSnapshot()

function withReviewSettings(snapshot: ReturnType<typeof baseSnapshot>, claimsBatchSize: number) {
  return { ...snapshot, contract: { ...snapshot.contract, reviewSettings: { claimsBatchSize } as never } }
}

/** Minimal completed record with the given identity fields. */
function record(parts: Partial<ReviewRecord> & { inputHash: string; stage: ReviewRecord['stage'] }): ReviewRecord {
  return {
    runId: `run_${randomUUID()}`,
    targetRefs: [],
    dependencyDigest: 'dep',
    contractHash: 'c',
    policyHash: 'p',
    reviewerConfigHash: 'r',
    promptHash: '',
    artifactHash: 'a',
    status: 'completed',
    inputTokens: 0,
    outputTokens: 0,
    startedAt: '2026-10-21T00:00:00.000Z',
    endedAt: '2026-10-21T00:00:01.000Z',
    ...parts,
  } as ReviewRecord
}

describe('F3.1 semanticContractHash', () => {
  it('is unchanged when reviewSettings (capacity) changes', () => {
    const snapshot = baseSnapshot()
    const revised = withReviewSettings(snapshot, 7)
    expect(semanticContractHash(snapshot.contract)).toBe(semanticContractHash(revised.contract))
  })

  it('changes when the contract question (semantics) changes', () => {
    const snapshot = baseSnapshot()
    const revised = { ...snapshot, contract: { ...snapshot.contract, question: 'A different question?' } }
    expect(semanticContractHash(snapshot.contract)).not.toBe(semanticContractHash(revised.contract))
  })

  it('semanticContract strips only reviewSettings', () => {
    const snapshot = baseSnapshot()
    const view = semanticContract(withReviewSettings(snapshot, 3).contract)
    expect('reviewSettings' in view).toBe(false)
    expect((view as { question: string }).question).toBe(snapshot.contract.question)
  })
})

describe('F3.1 site coverage — semantic mutation still invalidates everywhere', () => {
  it('auditDependencyDigest: reviewSettings change keeps the digest; question change invalidates', () => {
    const snapshot = withReviewSettings(baseSnapshot(), 1)
    const capacityOnly = withReviewSettings(baseSnapshot(), 5)
    const semantic = { ...baseSnapshot(), contract: { ...baseSnapshot().contract, question: 'Changed?' } }
    const digest = auditDependencyDigest(snapshot, 'art_x', [])
    expect(auditDependencyDigest(capacityOnly, 'art_x', [])).toBe(digest)
    expect(auditDependencyDigest(semantic, 'art_x', [])).not.toBe(digest)
  })

  it('matchesReviewTask: a record written under a different reviewSettings still matches; a question change does not', () => {
    const snapshot = withReviewSettings(baseSnapshot(), 1)
    const expected = {
      contractHash: semanticContractHash(snapshot.contract),
      dependencyDigest: 'dep',
      reviewerConfigHash: 'r',
    }
    const written = record({
      stage: 'claims',
      inputHash: 'k1',
      dependencyDigest: 'dep',
      contractHash: expected.contractHash,
      reviewerConfigHash: 'r',
      promptHash: 'ph',
      targetRefs: [{ id: 'claim_1', entityVersion: 1 }],
    })
    // Capacity change at revision time does not invalidate the record.
    const revisedCapacity = withReviewSettings(baseSnapshot(), 9)
    expect(semanticContractHash(revisedCapacity.contract)).toBe(expected.contractHash)
    // A semantic (question) change does.
    const changedContract = { ...snapshot, contract: { ...snapshot.contract, question: 'New question?' } }
    const changedExpected = {
      contractHash: semanticContractHash(changedContract.contract),
      dependencyDigest: 'dep',
      reviewerConfigHash: 'r',
    }
    expect(matchesReviewTask(written, { taskId: 't1', stage: 'claims', targetRefs: written.targetRefs, targetIds: ['claim_1'], requiredRules: [], envelope: {} }, changedExpected)).toBe(false)
  })
})

describe('F3.1 shared recordMatchesKey used by cache/audit/continue paths', () => {
  it('collectCachedRecords matches by the shared key matcher', () => {
    const root = mkdtempSync(join(tmpdir(), 'vwa-semantic-id-'))
    const projectId = 'prj_test'
    const store = new ReviewRunStore(root, projectId)
    const key = 'k'.repeat(64)
    store.writeRecord('run_a', record({ stage: 'claims', runId: 'run_a', inputHash: key }))
    store.writeRecord('run_a', record({ stage: 'claims', runId: 'run_a', inputHash: 'other' }))
    const cached = collectCachedRecords(root, projectId, key)
    expect(cached).toHaveLength(1)
    expect(cached[0]!.inputHash).toBe(key)
  })

  it('findReusableAudit/hasReusableAudit match via the shared matcher (extract/align pair, one run)', () => {
    const key = 'a'.repeat(64)
    const auditChecks = AUDIT_RULE_IDS.map((ruleId) => ({ ruleId, result: 'pass' as const, rationale: 'ok', evidenceIds: [] }))
    const align = record({
      stage: 'align',
      runId: 'run_x',
      inputHash: key,
      response: { stage: 'align', rubricVersion: 'humanities-v1', findings: [], targets: [{ targetId: `art_${randomUUID()}`, checks: auditChecks }], alignment: [] },
    })
    const extract = record({ stage: 'extract', runId: 'run_x', inputHash: key })
    expect(recordMatchesKey(align, key)).toBe(true)
    expect(hasReusableAudit([extract, align], key)).toBe(true)
    // A different key never qualifies.
    expect(findReusableAudit([extract, align], 'b'.repeat(64))).toBeUndefined()
  })
})
