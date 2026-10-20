/**
 * Feature C (design §C.2.3/§C.4): batched claims records match the per-claim
 * assessment tasks in the delivery check; single-target records do not.
 * @module tests/delivery-check
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { executeReviewRun } from '../src/review-runner.ts'
import { evaluateDelivery } from '../src/delivery-check.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import { BUDGET, fakeAdapter, makeClaim, makeSnapshot } from './review-helpers.ts'

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
      deps: { root, adapter, budget: BUDGET, contractHash: sha256Hex(stableJson(snapshotWithArtifact.contract)) },
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
    // The batched record covers both claims' claims-stage tasks (other stages
    // were not run, so the per-claim review state is incomplete, not current).
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
