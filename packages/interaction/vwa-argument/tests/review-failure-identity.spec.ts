/**
 * Every failure path must persist the same task identity as the success path.
 * `dependencyDigest` and `inputHash` are what progress reporting and cache
 * reuse key on, so a call site that omits them silently degrades to an
 * unkeyable record that no longer matches its task.
 * @module tests/review-failure-identity
 */

import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ReviewContextError } from '../src/review-call.ts'
import { executeReviewRun } from '../src/review-runner.ts'
import { sha256Hex } from '../src/schema.ts'
import { BUDGET, fakeAdapter, makeClaim, makeSnapshot, makeSource } from './review-helpers.ts'

/** Structured data is never windowed (E.2.1), so this must exceed 48K chars. */
const STRUCTURED = JSON.stringify({ rows: Array.from({ length: 4000 }, (_, i) => ({ id: i, note: 'x'.repeat(60) })) })
/** Large enough to serialize the structured source and reach the dispatch. */
const WIDE_LIMIT = 10_000_000

function sourcesResponse(sourceId: string): string {
  return JSON.stringify({
    stage: 'sources', rubricVersion: 'humanities-v1', findings: [],
    targets: [{
      targetId: sourceId,
      checks: ['SOURCE-01', 'SOURCE-02'].map((ruleId) => ({ ruleId, result: 'pass', rationale: 'r', evidenceIds: [] })),
    }],
  })
}

describe('failure records share the success-path task identity', () => {
  it('an envelope refusal, a dispatch failure and a completed run key identically', async () => {
    const source = { ...makeSource(), snapshotHash: sha256Hex(STRUCTURED) }
    const base = makeClaim('fact')
    const claim = { ...base, scope: { ...base.scope, corpus: [source.id] } }
    const snapshot = makeSnapshot({ sources: [source], claims: [claim] })

    // One fixture, three runs: the task identity must not depend on the root,
    // the run id or whether the dispatch happened.
    const run = (adapter: ReturnType<typeof fakeAdapter>, maxContextChars?: number) =>
      executeReviewRun({
        deps: {
          root: mkdtempSync(join(tmpdir(), 'vwa-identity-')),
          adapter, budget: BUDGET, contractHash: 'c'.repeat(64),
          readSnapshot: () => STRUCTURED,
          ...(maxContextChars === undefined ? {} : { maxContextChars }),
        },
        runId: `run_${randomUUID()}`,
        requestId: `req-${randomUUID()}`,
        stages: ['sources'],
        targetClaimIds: [claim.id],
        snapshot,
        signal: new AbortController().signal,
      })

    // (a) The oversized structured source is refused while the envelope is
    // built — before any dispatch — and the record still carries the identity.
    const refusedAdapter = fakeAdapter([() => ({ raw: sourcesResponse(source.id) })])
    const refused = await run(refusedAdapter)
    expect(refused.status).toBe('incomplete')
    expect(refusedAdapter.state.dispatches).toBe(0)
    expect(refused.records).toHaveLength(1)
    const refusedRecord = refused.records[0]!
    expect(refusedRecord).toMatchObject({
      status: 'error', errorCode: 'CONTEXT_TOO_LARGE',
      targetRefs: [{ id: source.id, entityVersion: source.entityVersion }],
    })
    expect(refusedRecord.dependencyDigest).toHaveLength(64)
    expect(refusedRecord.inputHash).toHaveLength(64)

    // (b) With room for the serialized source the dispatch runs and fails
    // permanently; that record must key identically.
    const failedAdapter = fakeAdapter([() => { throw new ReviewContextError('dispatch refused') }])
    const failed = await run(failedAdapter, WIDE_LIMIT)
    expect(failed.status).toBe('incomplete')
    expect(failedAdapter.state.dispatches).toBe(1)
    const failedRecord = failed.records[0]!
    expect(failedRecord.status).toBe('error')

    // (c) A successful run of the same task keys identically too.
    const completedAdapter = fakeAdapter([() => ({ raw: sourcesResponse(source.id) })])
    const completed = await run(completedAdapter, WIDE_LIMIT)
    expect(completed.status).toBe('completed')
    const completedRecord = completed.records.find((record) => record.status === 'completed')!

    expect(failedRecord.dependencyDigest).toBe(refusedRecord.dependencyDigest)
    expect(failedRecord.inputHash).toBe(refusedRecord.inputHash)
    expect(completedRecord.dependencyDigest).toBe(refusedRecord.dependencyDigest)
    expect(completedRecord.inputHash).toBe(refusedRecord.inputHash)
  })
})
