/**
 * Feature D §6.1/§6.2 (docs/plans/2026-11-15-vwa-autonomous-render-pipeline.md):
 * the canonical dispute resolver — content-derived ids, the origin-run cohort,
 * and the duplicate-id assertion (never merge).
 *
 * The TLA model `specs/tla/vwa-adjudication-durability` pins the same algebra:
 * `disputeId` is a pure function of `{inputHash, stage}` and the cohort is the
 * set of ORIGIN judgments, so cache reuse cannot move it.
 * @module tests/dispute
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { disputeId, resolveDisputes } from '../src/dispute.ts'
import { VwaFail } from '../src/store.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import { makeSnapshot } from './review-helpers.ts'
import type { Finding, Hash, Id, ReviewRecord, SemanticReviewRecord, Verdict } from '../src/types.ts'

const NOW = '2026-11-15T00:00:00.000Z'
const INPUT = 'i'.repeat(64)
const OTHER_INPUT = 'j'.repeat(64)
const TARGET = 'cl_11111111-1111-4111-8111-111111111111'
const OTHER_TARGET = 'cl_22222222-2222-4222-8222-222222222222'

function runId(): Id {
  return `run_${randomUUID()}`
}

function markerFinding(targetIds: Id[]): Finding {
  return {
    id: `finding_${randomUUID()}`,
    code: 'REVIEWER_DISAGREEMENT',
    targetIds,
    severity: 'major',
    explanation: 'identical inputs produced differing verdicts',
    evidenceIds: [],
    artifactSpans: [],
    repair: 'manual-review',
  }
}

/** One completed claims-stage judgment (optionally a persisted disagreement marker copy). */
function judgment(options: {
  runId: Id
  inputHash?: Hash
  verdict?: Verdict
  originRunId?: Id
  kind?: 'disagreement'
  findings?: Finding[]
  targetId?: Id
}): ReviewRecord & { kind?: 'disagreement' } {
  const record: SemanticReviewRecord = {
    runId: options.runId,
    stage: 'claims',
    targetRefs: [{ id: options.targetId ?? TARGET, entityVersion: 1 }],
    dependencyDigest: 'd'.repeat(64),
    contractHash: 'c'.repeat(64),
    policyHash: 'p'.repeat(64),
    reviewerConfigHash: 'r'.repeat(64),
    promptHash: 'q'.repeat(64),
    inputHash: options.inputHash ?? INPUT,
    status: 'completed',
    inputTokens: 0,
    outputTokens: 0,
    startedAt: NOW,
    endedAt: NOW,
    response: {
      stage: 'claims',
      rubricVersion: 'humanities-v1',
      findings: options.findings ?? [],
      targets: [
        {
          targetId: options.targetId ?? TARGET,
          checks: [
            { ruleId: 'HIST-01', result: options.verdict ?? 'pass', rationale: 'r', evidenceIds: [] },
          ],
          searchSufficiency: 'checked',
        },
      ],
    },
    ...(options.originRunId === undefined ? {} : { originRunId: options.originRunId }),
  }
  return options.kind === undefined ? record : { ...record, kind: options.kind }
}

describe('§6.1 dispute id derivation', () => {
  it('is the 16-hex stable-json hash of {inputHash, stage} with the finding_dis_ prefix', () => {
    const expected = `finding_dis_${sha256Hex(stableJson({ inputHash: INPUT, stage: 'claims' })).slice(0, 16)}`
    expect(disputeId(INPUT, 'claims')).toBe(expected)
    expect(disputeId(INPUT, 'claims')).toMatch(/^finding_dis_[0-9a-f]{16}$/)
    // Pure function: same inputs, same id; a different stage or input hash is a different dispute.
    expect(disputeId(INPUT, 'claims')).toBe(disputeId(INPUT, 'claims'))
    expect(disputeId(INPUT, 'arguments')).not.toBe(disputeId(INPUT, 'claims'))
    expect(disputeId(OTHER_INPUT, 'claims')).not.toBe(disputeId(INPUT, 'claims'))
  })

  it('the marker-minted finding id is not the dispute id (the resolver never depends on it)', () => {
    const snapshot = makeSnapshot()
    const marker = markerFinding([TARGET])
    const disputes = resolveDisputes(snapshot, [
      judgment({ runId: 'run_a', findings: [marker], kind: 'disagreement' }),
      judgment({ runId: 'run_b', verdict: 'fail' }),
    ])
    expect(disputes.map((d) => d.disputeId)).toEqual([disputeId(INPUT, 'claims')])
    expect(marker.id).not.toBe(disputes[0]!.disputeId)
  })
})

describe('§6.1 resolveDisputes', () => {
  it('resolves nothing without a persisted disagreement marker', () => {
    expect(resolveDisputes(makeSnapshot(), [])).toEqual([])
    expect(
      resolveDisputes(makeSnapshot(), [
        judgment({ runId: 'run_a' }),
        judgment({ runId: 'run_b', verdict: 'fail' }),
      ]),
    ).toEqual([])
  })

  it('recovers sorted, deduplicated targetIds from the persisted finding', () => {
    const marker = markerFinding([OTHER_TARGET, TARGET])
    const disputes = resolveDisputes(makeSnapshot(), [
      judgment({ runId: 'run_a', findings: [marker], kind: 'disagreement' }),
      judgment({ runId: 'run_b', verdict: 'fail' }),
    ])
    expect(disputes).toHaveLength(1)
    expect(disputes[0]).toMatchObject({
      disputeId: disputeId(INPUT, 'claims'),
      inputHash: INPUT,
      stage: 'claims',
      targetIds: [TARGET, OTHER_TARGET].sort(),
      originRunIds: ['run_a', 'run_b'],
    })
  })

  it('the cohort is the set of ORIGIN judgments, so a cached copy does not widen it', () => {
    const marker = markerFinding([TARGET])
    const disputes = resolveDisputes(makeSnapshot(), [
      judgment({ runId: 'run_a', findings: [marker], kind: 'disagreement' }),
      judgment({ runId: 'run_b', verdict: 'fail' }),
      // A cached save under a fresh run id: same provenance as run_a.
      judgment({ runId: 'run_c', originRunId: 'run_a' }),
    ])
    expect(disputes.map((d) => d.originRunIds)).toEqual([['run_a', 'run_b']])
  })

  it('a fresh judgment widens the cohort by its own run id', () => {
    const marker = markerFinding([TARGET])
    const disputes = resolveDisputes(makeSnapshot(), [
      judgment({ runId: 'run_a', findings: [marker], kind: 'disagreement' }),
      judgment({ runId: 'run_b', verdict: 'fail' }),
      judgment({ runId: 'run_d', verdict: 'fail' }),
    ])
    expect(disputes.map((d) => d.originRunIds)).toEqual([['run_a', 'run_b', 'run_d']])
  })

  it('keeps disputes separate per {inputHash, stage}, sorted by dispute id', () => {
    const snapshot = makeSnapshot()
    const disputes = resolveDisputes(snapshot, [
      judgment({ runId: 'run_a', inputHash: INPUT, findings: [markerFinding([TARGET])], kind: 'disagreement' }),
      judgment({ runId: 'run_b', inputHash: INPUT, verdict: 'fail' }),
      judgment({ runId: 'run_x', inputHash: OTHER_INPUT, findings: [markerFinding([TARGET])], kind: 'disagreement' }),
      judgment({ runId: 'run_y', inputHash: OTHER_INPUT, verdict: 'fail' }),
    ])
    expect(disputes.map((d) => d.disputeId)).toEqual(
      [disputeId(INPUT, 'claims'), disputeId(OTHER_INPUT, 'claims')].sort(),
    )
    const byId = new Map(disputes.map((d) => [d.disputeId, d]))
    expect(byId.get(disputeId(INPUT, 'claims'))!.originRunIds).toEqual(['run_a', 'run_b'])
    expect(byId.get(disputeId(OTHER_INPUT, 'claims'))!.originRunIds).toEqual(['run_x', 'run_y'])
  })

  it('collapses repeated markers of the same dispute instead of merging them', () => {
    // A re-run re-detects the same disagreement and persists a second marker
    // copy under the same {inputHash, stage}: still exactly one dispute.
    const disputes = resolveDisputes(makeSnapshot(), [
      judgment({ runId: 'run_a', findings: [markerFinding([TARGET])], kind: 'disagreement' }),
      judgment({ runId: 'run_b', verdict: 'fail' }),
      judgment({ runId: 'run_b', findings: [markerFinding([TARGET])], kind: 'disagreement' }),
    ])
    expect(disputes).toHaveLength(1)
    expect(disputes[0]!.originRunIds).toEqual(['run_a', 'run_b'])
  })

  it('fails SCHEMA_INVALID duplicate disputeId rather than merging a conflicting marker', () => {
    const conflicting = () =>
      resolveDisputes(makeSnapshot(), [
        judgment({ runId: 'run_a', findings: [markerFinding([TARGET])], kind: 'disagreement' }),
        judgment({ runId: 'run_b', verdict: 'fail' }),
        judgment({ runId: 'run_b', findings: [markerFinding([OTHER_TARGET])], kind: 'disagreement' }),
      ])
    expect(conflicting).toThrow(VwaFail)
    expect(conflicting).toThrow(/duplicate disputeId/)
    try {
      conflicting()
    } catch (error) {
      expect((error as VwaFail).fail.code).toBe('SCHEMA_INVALID')
    }
  })

  it('ignores extract-stage records: audit is not a dispute stage', () => {
    // Even a marker finding on an audit record creates no dispute: audit
    // findings have their own identity and are never reviewer disagreements.
    const extraction = {
      runId: 'run_a',
      stage: 'extract',
      targetRefs: [],
      dependencyDigest: 'd'.repeat(64),
      contractHash: 'c'.repeat(64),
      policyHash: 'p'.repeat(64),
      reviewerConfigHash: 'r'.repeat(64),
      promptHash: 'q'.repeat(64),
      inputHash: INPUT,
      status: 'completed',
      inputTokens: 0,
      outputTokens: 0,
      startedAt: NOW,
      endedAt: NOW,
      response: { items: [], findings: [markerFinding([TARGET])] },
    } as unknown as ReviewRecord
    expect(resolveDisputes(makeSnapshot(), [extraction])).toEqual([])
  })
})
