/**
 * Feature C (design §C.2.3/§C.4): batched claims records match the per-claim
 * assessment tasks in the delivery check; single-target records do not.
 * @module tests/delivery-check
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { semanticContractHash } from '../src/review-contract.ts'
import { describe, expect, it } from 'vitest'
import { executeReviewRun } from '../src/review-runner.ts'
import { evaluateDelivery } from '../src/delivery-check.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import { ReviewContextError } from '../src/review-call.ts'
import { BUDGET, fakeAdapter, makeArgument, makeClaim, makeSnapshot } from './review-helpers.ts'

/** One schema-valid claims response covering EVERY target the task carried. */
function batchedClaimsResponse(claimIds: string[], result: 'pass'): string {
  return JSON.stringify({
    stage: 'claims',
    rubricVersion: 'humanities-v1',
    findings: [],
    targets: claimIds.map((targetId) => ({
      targetId,
      checks: [{ ruleId: 'HIST-01', result, rationale: 'r', evidenceIds: [] }],
      searchSufficiency: 'checked',
    })),
  })
}

function fixture(batchSize: number, claims = [makeClaim('fact', 'The council closed the port in May.'), makeClaim('fact', 'The vote passed unanimously.')]) {
  const root = mkdtempSync(join(tmpdir(), 'vwa-delivery-'))
  const snapshot = makeSnapshot({
    claims,
    contract: {
      ...makeSnapshot().contract,
      reviewSettings: { budget: BUDGET, maxArtifactChars: 120_000, maxContextChars: 48_000, claimsBatchSize: batchSize },
    },
  })
  const body = `# Port\n\n${claims[0]!.text}\n\n${claims[1]!.text}\n`
  writeFileSync(join(root, 'report.md'), body)
  const artifactId = `art_${randomUUID()}`
  const snapshotWithArtifact = structuredClone(snapshot)
  snapshotWithArtifact.artifacts.push({
    id: artifactId,
    entityVersion: 1,
    createdAt: '',
    updatedAt: '',
    path: 'report.md',
    contentHash: sha256Hex(body),
    outline: [],
    occurrences: [
      { claimId: claims[0]!.id, span: { start: 8, end: 8 + claims[0]!.text.length }, exactText: claims[0]!.text },
      {
        claimId: claims[1]!.id,
        span: { start: body.indexOf(claims[1]!.text), end: body.indexOf(claims[1]!.text) + claims[1]!.text.length },
        exactText: claims[1]!.text,
      },
    ],
  })
  const adapter = fakeAdapter([
    (req) => {
      const envelope = JSON.parse(req.messages[1]!.content) as {
        dependencies: { targets?: { id: string }[]; target?: { id: string } }
      }
      const targets = envelope.dependencies.targets ?? [envelope.dependencies.target!]
      return { raw: batchedClaimsResponse(targets.map((t) => t.id), 'pass') }
    },
  ])
  const run = () =>
    executeReviewRun({
      deps: { root, adapter, budget: BUDGET, contractHash: semanticContractHash(snapshotWithArtifact.contract) },
      runId: `run_${randomUUID()}`,
      requestId: randomUUID(),
      stages: ['claims'],
      targetClaimIds: claims.map((c) => c.id),
      snapshot: snapshotWithArtifact,
      signal: new AbortController().signal,
    })
  return { root, claims, snapshot: snapshotWithArtifact, artifactId, body, run }
}

describe('Feature C — delivery per-claim assessments over batched claims records', () => {
  it.each([1, 2, 3, 4])('keeps interleaved argument dependencies current with batch size %i', async (batchSize) => {
    const claims = [makeClaim('fact', 'A.'), makeClaim('fact', 'B.'), makeClaim('fact', 'C.')]
    const f = fixture(batchSize, claims)
    // Global batches at size 2 are [A, B], [C], while A/C's closure is [A, C].
    f.snapshot.arguments.push(makeArgument(claims[2]!.id, [claims[0]!.id], []))
    const adapter = fakeAdapter([(req) => {
      const envelope = JSON.parse(req.messages[1]!.content) as {
        stage: 'claims' | 'arguments'
        requiredRules: { targetId: string; ruleId: string }[]
      }
      return { raw: JSON.stringify({
        stage: envelope.stage, rubricVersion: 'humanities-v1', findings: [],
        targets: [...new Set(envelope.requiredRules.map((r) => r.targetId))].map((targetId) => ({
          targetId,
          checks: envelope.requiredRules.filter((r) => r.targetId === targetId).map(({ ruleId }) => ({
            ruleId, result: 'pass', rationale: 'reviewed', evidenceIds: [],
          })),
          ...(envelope.stage === 'claims' ? { searchSufficiency: 'checked' } : { adequacy: 'adequate' }),
        })),
      }) }
    }])
    const outcome = await executeReviewRun({
      deps: { root: f.root, adapter, budget: BUDGET, contractHash: semanticContractHash(f.snapshot.contract) },
      runId: `run_${randomUUID()}`, requestId: randomUUID(), stages: ['claims', 'arguments'],
      targetClaimIds: claims.map((c) => c.id), snapshot: f.snapshot, signal: new AbortController().signal,
    })
    expect(outcome.status).toBe('completed')
    const check = evaluateDelivery({
      root: f.root, snapshot: f.snapshot, artifactId: f.artifactId, text: f.body,
      records: outcome.records, pendingRunIds: [], adjudications: [],
    })
    expect(check.checks.argument).toBe('pass')
    expect(check.assessments).toHaveLength(3)
    expect(check.assessments.map((a) => a.reviewState)).toEqual(['current', 'current', 'current'])

    // A missing global batch must still leave its claim unreviewed.
    const withoutLastBatch = outcome.records.filter((r) =>
      r.stage !== 'claims' || !r.targetRefs.some((ref) => ref.id === claims[2]!.id),
    )
    const incomplete = evaluateDelivery({
      root: f.root, snapshot: f.snapshot, artifactId: f.artifactId, text: f.body,
      records: withoutLastBatch, pendingRunIds: [], adjudications: [],
    })
    expect(incomplete.assessments.find((a) => a.claimId === claims[2]!.id)?.reviewState).not.toBe('current')
    expect(incomplete.assessments.find((a) => a.claimId === claims[0]!.id)?.reviewState).not.toBe('current')
    expect(incomplete.checks.argument).not.toBe('pass')
  })

  it('batched records match the per-claim assessment tasks (reviewRunIds populated)', async () => {
    const f = fixture(2)
    const outcome = await f.run()
    expect(outcome.status).toBe('completed')
    const check = evaluateDelivery({
      root: f.root,
      snapshot: f.snapshot,
      artifactId: f.artifactId,
      text: f.body,
      records: outcome.records,
      pendingRunIds: [],
      adjudications: [],
    })
    const claimsAssessments = check.assessments.filter((a) => f.claims.some((c) => c.id === a.claimId))
    // The batched record covers both claims; the other stages are inapplicable.
    expect(claimsAssessments.length).toBeGreaterThan(0)
    for (const assessment of claimsAssessments) {
      expect(assessment.reviewRunIds).toContain(outcome.runId)
      expect(assessment.reviewState).toBe('current')
    }
  })

  it('single-target records are stale against a batched plan (not current)', async () => {
    // SAME claim ids in both plans; only the frozen batch size differs.
    const claims = [makeClaim('fact', 'The council closed the port in May.'), makeClaim('fact', 'The vote passed unanimously.')]
    const single = fixture(1, claims)
    const batched = fixture(2, claims)
    const outcome = await single.run()
    expect(outcome.status).toBe('completed')
    const check = evaluateDelivery({
      root: batched.root,
      snapshot: batched.snapshot,
      artifactId: batched.artifactId,
      text: batched.body,
      records: outcome.records,
      pendingRunIds: [],
      adjudications: [],
    })
    const claimsAssessments = check.assessments.filter((a) => batched.claims.some((c) => c.id === a.claimId))
    for (const assessment of claimsAssessments) {
      // The batched plan's tasks never match single-target records.
      expect(assessment.reviewState).toBe('stale')
      expect(assessment.reviewRunIds).not.toContain(outcome.runId)
    }
  })
})

describe('Feature D — report stage progress and failure detail (§D.2)', () => {
  it('stageProgress accounts for batching and separates completed/failed/not-run', async () => {
    // 4 claims at batch size 2 → 2 planned tasks; one batch passes, one fails.
    const claims = [makeClaim('fact', 'A.'), makeClaim('fact', 'B.'), makeClaim('fact', 'C.'), makeClaim('fact', 'D.')]
    const f = fixture(2, claims)
    const adapter = fakeAdapter([
      (req) => {
        const envelope = JSON.parse(req.messages[1]!.content) as {
          dependencies: { targets?: { id: string }[] }
        }
        const targets = envelope.dependencies.targets ?? []
        if (targets.some((t) => t.id === claims[2]!.id))
          // Permanent class: no retry/backoff, and it exercises the budget bucket.
          throw new ReviewContextError('context exceeds the per-call limit')
        return { raw: batchedClaimsResponse(targets.map((t) => t.id), 'pass') }
      },
    ])
    const outcome = await executeReviewRun({
      deps: { root: f.root, adapter, budget: BUDGET, contractHash: semanticContractHash(f.snapshot.contract) },
      runId: `run_${randomUUID()}`, requestId: randomUUID(), stages: ['claims'],
      targetClaimIds: claims.map((c) => c.id), snapshot: f.snapshot, signal: new AbortController().signal,
    })
    const check = evaluateDelivery({
      root: f.root, snapshot: f.snapshot, artifactId: f.artifactId, text: f.body,
      records: outcome.records, pendingRunIds: [], adjudications: [],
    })
    expect(check.stageProgress.claims).toMatchObject({
      total: 2, completed: 1, failed: 1, notRun: 0,
      channelErrors: 0, schemaErrors: 0, budgetErrors: 1, lastRunStatus: 'error',
    })
    // Empty stages are planned with zero tasks and never reviewed.
    expect(check.stageProgress.sources).toMatchObject({ total: 0, completed: 0, failed: 0, notRun: 0 })
  })

  it('failures carry the Feature B errorDetail from the error record', async () => {
    const f = fixture(3, [makeClaim('fact', 'A.'), makeClaim('fact', 'B.'), makeClaim('fact', 'C.')])
    const adapter = fakeAdapter([
      () => {
        // Permanent class: no retry/backoff; budget bucket classification.
        throw new ReviewContextError('context exceeds the per-call limit')
      },
    ])
    const outcome = await executeReviewRun({
      deps: { root: f.root, adapter, budget: BUDGET, contractHash: semanticContractHash(f.snapshot.contract) },
      runId: `run_${randomUUID()}`, requestId: randomUUID(), stages: ['claims'],
      targetClaimIds: f.claims.map((c) => c.id), snapshot: f.snapshot, signal: new AbortController().signal,
    })
    const check = evaluateDelivery({
      root: f.root, snapshot: f.snapshot, artifactId: f.artifactId, text: f.body,
      records: outcome.records, pendingRunIds: [], adjudications: [],
    })
    expect(check.stageProgress.claims).toMatchObject({ total: 1, completed: 0, failed: 1, notRun: 0 })
    expect(check.failures).toHaveLength(1)
    expect(check.failures[0]).toMatchObject({
      stage: 'claims', errorCode: 'CONTEXT_TOO_LARGE', runId: outcome.runId,
    })
    expect(check.failures[0]!.errorDetail).toMatchObject({ message: 'context exceeds the per-call limit' })
    expect(check.failures[0]!.targetIds).toEqual(expect.arrayContaining(f.claims.map((c) => c.id)))
  })
})

describe('report progress regressions', () => {
  it('counts a failed argument-only run against the historical claim inputs it reviewed', async () => {
    const f = fixture(1)
    const [premise, conclusion] = f.claims
    f.snapshot.arguments.push(makeArgument(conclusion!.id, [premise!.id], []))
    const claims = await f.run()
    expect(claims.status).toBe('completed')
    const outcome = await executeReviewRun({
      deps: {
        root: f.root, budget: BUDGET, contractHash: semanticContractHash(f.snapshot.contract),
        adapter: fakeAdapter([(req) => {
          const envelope = JSON.parse(req.messages[1]!.content) as {
            context: { currentReviews: { stage: string }[] }
          }
          expect(envelope.context.currentReviews).toEqual(expect.arrayContaining([
            expect.objectContaining({ stage: 'claims' }),
          ]))
          throw new ReviewContextError('argument context too large')
        }]),
      },
      runId: `run_${randomUUID()}`, requestId: randomUUID(), stages: ['arguments'],
      targetClaimIds: f.claims.map((claim) => claim.id), snapshot: f.snapshot,
      signal: new AbortController().signal,
    })
    expect(outcome.records).toHaveLength(1)
    expect(outcome.records[0]).toMatchObject({ stage: 'arguments', status: 'error', errorCode: 'CONTEXT_TOO_LARGE' })
    const check = evaluateDelivery({
      root: f.root, snapshot: f.snapshot, artifactId: f.artifactId, text: f.body,
      records: [...claims.records, ...outcome.records], pendingRunIds: [], adjudications: [],
    })
    expect(check.stageProgress.arguments).toMatchObject({ total: 1, completed: 0, failed: 1, notRun: 0 })
    expect(check.failures).toEqual([expect.objectContaining({ runId: outcome.runId, stage: 'arguments' })])
  })

  it.each(['entity', 'contract', 'dependency', 'reviewer', 'prompt', 'policy', 'scope'] as const)(
    'does not count historical %s inputs as current progress', async (change) => {
      const f = fixture(1)
      const outcome = await f.run()
      if (change === 'entity') for (const claim of f.snapshot.claims) claim.entityVersion += 1
      if (change === 'contract') f.snapshot.contract.question += ' Updated.'
      if (change === 'dependency') f.snapshot.searches.push({
        id: `srch_${randomUUID()}`, entityVersion: 1, createdAt: '', updatedAt: '',
        targetIds: f.claims.map((c) => c.id), corpus: [], resultSourceIds: [],
        query: 'new search', purpose: 'check', tool: 'search', performedAt: '', state: 'executed',
        inaccessible: [], finding: 'none-found',
      })
      if (change === 'prompt') for (const record of outcome.records) record.promptHash = 'old prompt'
      if (change === 'policy') for (const record of outcome.records) record.policyHash = 'old policy'
      if (change === 'scope') for (const record of outcome.records) record.inputHash = 'old scope'
      const check = evaluateDelivery({
        root: f.root, snapshot: f.snapshot, artifactId: f.artifactId, text: f.body,
        records: outcome.records, pendingRunIds: [], adjudications: [],
        ...(change === 'reviewer' ? { reviewerConfigHash: 'new reviewer' } : {}),
      })
      expect(check.stageProgress.claims).toMatchObject({ total: 2, completed: 0, notRun: 2 })
    },
  )

  it('does not let a stale failure override a current completed review', async () => {
    const f = fixture(1)
    const outcome = await f.run()
    const stale = {
      ...outcome.records[0]!, runId: `run_${randomUUID()}`, contractHash: 'old contract',
      status: 'error' as const, errorCode: 'REVIEW_UNAVAILABLE', endedAt: '2099-01-01',
    }
    const check = evaluateDelivery({
      root: f.root, snapshot: f.snapshot, artifactId: f.artifactId, text: f.body,
      records: [...outcome.records, stale], pendingRunIds: [], adjudications: [],
    })
    expect(check.stageProgress.claims).toMatchObject({ completed: 2, failed: 0, notRun: 0 })
    // Historical failures remain available for diagnosis, separate from current task counts.
    expect(check.failures).toHaveLength(1)
  })

  it('reports a real audit failure with its artifact target and error detail', async () => {
    const f = fixture(1)
    const outcome = await executeReviewRun({
      deps: { root: f.root, adapter: fakeAdapter([() => { throw new ReviewContextError('audit context too large') }]),
        budget: BUDGET, contractHash: semanticContractHash(f.snapshot.contract) },
      runId: `run_${randomUUID()}`, requestId: randomUUID(), stages: ['audit'],
      targetClaimIds: f.claims.map((c) => c.id), snapshot: f.snapshot,
      artifact: { id: f.artifactId, path: 'report.md', text: f.body }, signal: new AbortController().signal,
    })
    const check = evaluateDelivery({
      root: f.root, snapshot: f.snapshot, artifactId: f.artifactId, text: f.body,
      records: outcome.records, pendingRunIds: [], adjudications: [],
    })
    expect(check.stageProgress.audit).toMatchObject({ total: 1, completed: 0, failed: 1, notRun: 0, budgetErrors: 1 })
    expect(check.failures).toEqual([expect.objectContaining({
      stage: 'audit', targetIds: [f.artifactId], errorCode: 'CONTEXT_TOO_LARGE',
      errorDetail: expect.objectContaining({ message: 'audit context too large' }),
    })])
    // Another artifact must not inherit this task failure.
    const changed = structuredClone(f.snapshot)
    changed.artifacts[0]!.entityVersion += 1
    const stale = evaluateDelivery({
      root: f.root, snapshot: changed, artifactId: f.artifactId, text: f.body,
      records: outcome.records, pendingRunIds: [], adjudications: [],
    })
    expect(stale.stageProgress.audit).toMatchObject({ completed: 0, failed: 0, notRun: 1 })
  })

  it('counts a completed same-run extract/align pair as one audit task', async () => {
    const f = fixture(1)
    const { auditDependencyDigest } = await import('../src/review-current.ts')
    const { policyHash, promptHash } = await import('../src/review-contract.ts')
    const base = {
      runId: `run_${randomUUID()}`, targetRefs: [{ id: f.artifactId, entityVersion: 1 }],
      dependencyDigest: auditDependencyDigest(f.snapshot, f.artifactId, []), artifactHash: sha256Hex(f.body),
      contractHash: semanticContractHash(f.snapshot.contract), policyHash: policyHash(),
      reviewerConfigHash: 'reviewer', inputHash: 'audit-key', status: 'completed' as const,
      inputTokens: 0, outputTokens: 0, startedAt: '2026-10-20', endedAt: '2026-10-20',
    }
    const records: import('../src/types.ts').ReviewRecord[] = [
      { ...base, stage: 'extract', promptHash: promptHash('extract'), response: { items: [] } },
      { ...base, stage: 'align', promptHash: promptHash('align'), response: { stage: 'align', rubricVersion: 'humanities-v1', targets: [], findings: [] } },
    ]
    const check = (rows = records) => evaluateDelivery({
      root: f.root, snapshot: f.snapshot, artifactId: f.artifactId, text: f.body,
      records: rows, pendingRunIds: [], adjudications: [],
    })
    expect(check().stageProgress.audit).toMatchObject({ total: 1, completed: 1, failed: 0, notRun: 0 })
    expect(check(records.slice(0, 1)).stageProgress.audit).toMatchObject({ completed: 0, notRun: 1 })
    const splitRuns = structuredClone(records)
    splitRuns[1]!.runId = `run_${randomUUID()}`
    expect(check(splitRuns).stageProgress.audit).toMatchObject({ completed: 0, notRun: 1 })
    f.snapshot.artifacts[0]!.entityVersion += 1
    expect(check().stageProgress.audit).toMatchObject({ completed: 0, notRun: 1 })
  })
})
