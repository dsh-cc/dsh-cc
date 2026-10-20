/**
 * Feature C (design §C.2.3/§C.4): batched claims records match the planned
 * tasks in currentReviews; single-target records are historical against a
 * batched plan.
 * @module tests/review-current
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { executeReviewRun } from '../src/review-runner.ts'
import { currentReviews } from '../src/review-current.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import type { ProjectContract } from '../src/types.ts'
import { BUDGET, fakeAdapter, makeClaim, makeSnapshot } from './review-helpers.ts'

/** One schema-valid claims response covering EVERY batched target. */
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

function contractWithBatch(batchSize: number): ProjectContract {
  return {
    ...makeSnapshot().contract,
    reviewSettings: { budget: BUDGET, maxArtifactChars: 120_000, maxContextChars: 48_000, claimsBatchSize: batchSize },
  }
}

function batchedFixture(batchSize: number) {
  const root = mkdtempSync(join(tmpdir(), 'vwa-current-'))
  const claims = [makeClaim('fact'), makeClaim('fact'), makeClaim('fact')]
  const snapshot = makeSnapshot({ claims, contract: contractWithBatch(batchSize) })
  // Respond to whatever targets the (possibly batched) task carried.
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
      deps: { root, adapter, budget: BUDGET, contractHash: sha256Hex(stableJson(snapshot.contract)) },
      runId: `run_${randomUUID()}`,
      requestId: randomUUID(),
      stages: ['claims'],
      targetClaimIds: claims.map((c) => c.id),
      snapshot,
      signal: new AbortController().signal,
    })
  return { root, claims, snapshot, adapter, run }
}

describe('Feature C — currentReviews over batched claims records', () => {
  it('batched records match the planned batched tasks (claims verdict pass)', async () => {
    const f = batchedFixture(2)
    const outcome = await f.run()
    expect(outcome.status).toBe('completed')
    expect(outcome.records).toHaveLength(2) // 3 claims, batch 2 → 2 tasks
    expect(outcome.records[0]!.targetRefs).toHaveLength(2)
    const current = currentReviews(f.snapshot, outcome.records, f.claims.map((c) => c.id))
    expect(current.stages.claims).toBe('pass')
    expect(current.records).toHaveLength(2)
  })

  it('single-target records do not match a batched plan (historical, not-run)', async () => {
    const f = batchedFixture(2)
    const single = batchedFixture(1)
    const outcome = await single.run()
    expect(outcome.status).toBe('completed')
    const current = currentReviews(f.snapshot, outcome.records, f.claims.map((c) => c.id))
    // Batched task targetRefs (two ids) never match single-target records.
    expect(current.records).toHaveLength(0)
    expect(current.stages.claims).toBe('not-run')
  })
})
