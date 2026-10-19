/**
 * Slice-3 runner spec: D13b (needs-review inside completed records; fabricated
 * ids), D14 (budget/timeout/cancel/restart → incomplete; reserved accounting),
 * D19 (reviewer disagreement; fail not auto-cleared), and the §11.3 cache.
 * @module tests/review-runner
 */

import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { collectCachedRecords, executeReviewRun } from '../src/review-runner.ts'
import { ReviewRunStore, recordReusable } from '../src/review-run-store.ts'
import { activeMajorCount } from '../src/policy.ts'
import type { ReviewRecord } from '../src/types.ts'
import {
  BUDGET, claimsResponse, completedRecord, fakeAdapter, makeClaim, makeSnapshot, type FakeAdapterState,
} from './review-helpers.ts'

function workspace(): { root: string } {
  return { root: mkdtempSync(join(tmpdir(), 'vwa-run-')) }
}

function runnerInput(root: string, snapshot: ProjectSnapshot_, stages: ('claims' | 'sources' | 'support' | 'arguments')[], runId = `run_${randomUUID()}`) {
  return {
    deps: { root, adapter: undefined as never, budget: BUDGET, contractHash: 'c'.repeat(64) },
    runId,
    requestId: `req-${Math.random()}`,
    stages,
    targetClaimIds: snapshot.claims.map((claim) => claim.id),
    snapshot,
    signal: new AbortController().signal,
  }
}
type ProjectSnapshot_ = ReturnType<typeof makeSnapshot>

describe('D13b — present-rule needs-review inside a completed record', () => {
  it('stores needs-review in a completed record and does not count it as an error', async () => {
    const { root } = workspace()
    const claim = makeClaim('fact')
    const snapshot = makeSnapshot({ claims: [claim] })
    const adapter = fakeAdapter([() => ({ raw: claimsResponse(claim.id, 'needs-review') })])
    const outcome = await executeReviewRun({ ...runnerInput(root, snapshot, ['claims']), deps: { ...runnerInput(root, snapshot, ['claims']).deps, adapter } })
    expect(outcome.status).toBe('completed')
    const record = completedRecord(outcome.records)
    expect(record.errorCode).toBeUndefined()
    expect(record.response?.targets[0]?.checks[0]?.result).toBe('needs-review')
  })

  it('fabricated ids invalidate the response: error record REVIEW_INVALID, nothing reusable', async () => {
    const { root } = workspace()
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const fakeClaimId = `cl_${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}`
    const adapter = fakeAdapter([() => ({ raw: claimsResponse(fakeClaimId, 'pass') })])
    // B.2.4: invalid responses now retry with backoff — virtualize the sleeps.
    vi.useFakeTimers()
    const run = executeReviewRun({ ...runnerInput(root, snapshot, ['claims']), deps: { ...runnerInput(root, snapshot, ['claims']).deps, adapter } })
    await vi.runAllTimersAsync()
    const outcome = await run
    const record = outcome.records[0]!
    expect(record.status).toBe('error')
    expect(record.errorCode).toBe('REVIEW_INVALID')
    expect(recordReusable(record, new Set(['HIST-01']))).toBe(false)
    // §11.3: the invalid record never enters the cache — a second run dispatches again.
    const before = adapter.state.dispatches
    const run2 = executeReviewRun({ ...runnerInput(root, snapshot, ['claims']), requestId: 'req-2', deps: { ...runnerInput(root, snapshot, ['claims']).deps, adapter } })
    await vi.runAllTimersAsync()
    const second = await run2
    vi.useRealTimers()
    expect(second.records[0]?.inputHash).toBeDefined()
    expect(adapter.state.dispatches).toBeGreaterThan(before)
  })
})

describe('D14 — budget / timeout / cancel / restart', () => {
  it('stops with budget-exhausted when maxCallsPerRun is exhausted; reservation charged continuously', async () => {
    const { root } = workspace()
    const snapshot = makeSnapshot({ claims: [makeClaim('fact'), makeClaim('fact')] })
    const adapter = fakeAdapter([
      (_req) => {
        const claim = snapshot.claims[0]!
        return { raw: claimsResponse(claim.id, 'pass'), inputTokens: 10, outputTokens: 5 }
      },
    ])
    const outcome = await executeReviewRun({
      ...runnerInput(root, snapshot, ['claims']),
      deps: { ...runnerInput(root, snapshot, ['claims']).deps, adapter, budget: { ...BUDGET, maxCallsPerRun: 1 } },
    })
    expect(outcome.status).toBe('budget-exhausted')
    expect(outcome.calls).toBe(1)
    // Actual usage (10/5) settled the reservation — no double counting.
    expect(outcome.inputTokens).toBe(10)
    expect(outcome.outputTokens).toBe(5)
  })

  it('charges the FULL reserved output cap when no actual usage is available', async () => {
    const { root } = workspace()
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const adapter = fakeAdapter([() => ({ raw: claimsResponse(snapshot.claims[0]!.id, 'pass') })])
    const outcome = await executeReviewRun({ ...runnerInput(root, snapshot, ['claims']), deps: { ...runnerInput(root, snapshot, ['claims']).deps, adapter } })
    expect(outcome.outputTokens).toBe(BUDGET.maxOutputTokensPerCall)
  })

  it('a call timeout leaves an error record with the reserve charged and the run not completed-clean', async () => {
    const { root } = workspace()
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const adapter = fakeAdapter([
      () => new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('dispatch hung')), 50)
      }),
    ])
    // B.2.4: transient timeouts now retry with a 5s backoff — virtualize the sleeps.
    vi.useFakeTimers()
    const run = executeReviewRun({
      ...runnerInput(root, snapshot, ['claims']),
      deps: { ...runnerInput(root, snapshot, ['claims']).deps, adapter, budget: { ...BUDGET, callTimeoutMs: 10 } },
    })
    await vi.runAllTimersAsync()
    const outcome = await run
    vi.useRealTimers()
    const record = outcome.records[0]!
    expect(record.errorCode).toBe('REVIEW_UNAVAILABLE')
    // Reserved output was charged for the timed-out task (§13).
    expect(outcome.outputTokens).toBeGreaterThanOrEqual(BUDGET.maxOutputTokensPerCall)
  })

  it('cancellation before the run leaves status cancelled', async () => {
    const { root } = workspace()
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const controller = new AbortController()
    controller.abort()
    const adapter = fakeAdapter([() => ({ raw: claimsResponse(snapshot.claims[0]!.id, 'pass') })])
    const outcome = await executeReviewRun({ ...runnerInput(root, snapshot, ['claims']), signal: controller.signal, deps: { ...runnerInput(root, snapshot, ['claims']).deps, adapter } })
    expect(outcome.status).toBe('cancelled')
  })

  it('a persisted running run becomes incomplete on load (restart rule, §14.3)', async () => {
    const { root } = workspace()
    const projectId = makeSnapshot().projectId
    const store = new ReviewRunStore(root, projectId)
    store.initRun('run_00000000-0000-4000-8000-000000000000')
    store.writeRequest('run_00000000-0000-4000-8000-000000000000', {
      schemaVersion: 1, requestId: 'req-x', runId: 'run_00000000-0000-4000-8000-000000000000',
      stage: 'claims', targetClaimIds: [], status: 'running', inputTokens: 5, outputTokens: 3000, calls: 1,
      startedAt: '2026-10-16T00:00:00.000Z',
    })
    const loaded = store.loadRequest('run_00000000-0000-4000-8000-000000000000')
    expect(loaded?.status).toBe('incomplete')
    // In-flight budgets stay charged across the restart.
    expect(loaded?.outputTokens).toBe(3000)
  })
})

describe('D19 — a new request cannot brush out a fail without adjudication', () => {
  it('same inputs, differing verdicts → reviewer-disagreement; the fail record persists', async () => {
    const { root } = workspace()
    const claim = makeClaim('fact')
    const snapshot = makeSnapshot({ claims: [claim] })
    // Run 1: HIST-01 fail.
    const failAdapter = fakeAdapter([() => ({ raw: claimsResponse(claim.id, 'fail') })])
    const first = await executeReviewRun({ ...runnerInput(root, snapshot, ['claims']), deps: { ...runnerInput(root, snapshot, ['claims']).deps, adapter: failAdapter } })
    // Run 2: same inputs, PASS verdict, fresh requestId.
    const passAdapter = fakeAdapter([() => ({ raw: claimsResponse(claim.id, 'pass') })])
    const second = await executeReviewRun({ ...runnerInput(root, snapshot, ['claims']), requestId: 'req-2', deps: { ...runnerInput(root, snapshot, ['claims']).deps, adapter: passAdapter } })
    // eslint-disable-next-line no-console
    console.log('DBG1', JSON.stringify(first.records.map((r) => [r.status, r.inputHash?.slice(0, 8), r.response?.targets[0]?.checks[0]?.result])), 'DBG2', JSON.stringify(second.records.map((r) => [r.status, r.inputHash?.slice(0, 8), r.response?.targets[0]?.checks[0]?.result])))
    expect(second.findings).toHaveLength(1)
    const finding = second.findings[0] as { code: string; kind: string; severity: string }
    expect(finding.code).toBe('REVIEWER_DISAGREEMENT')
    expect(finding.kind).toBe('disagreement')
    // Excluded from major→fail counting (§11.3/§17.2).
    expect(activeMajorCount([finding as never], [])).toEqual({ blocker: 0, major: 0 })
    // The original fail record is NOT silently cleared.
    const failRecords = new ReviewRunStore(root, snapshot.projectId).readRecords(first.runId)
    expect(failRecords.some((record) => record.response?.targets[0]?.checks[0]?.result === 'fail')).toBe(true)
  })
})

describe('B.2.1 — error records carry structured errorDetail', () => {
  it('a dispatch failure surfaces message, httpStatus and retryAttempts in the error record', async () => {
    const { root } = workspace()
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const boom: Error & { detail?: { message: string; httpStatus: number; providerCode: string } } =
      new Error('review dispatch failed: upstream unavailable')
    boom.detail = { message: 'upstream unavailable', httpStatus: 503, providerCode: 'overloaded' }
    const adapter = fakeAdapter([() => { throw boom }])
    // Transport errors are transient → one retry with a 5s backoff — virtualize the sleeps.
    vi.useFakeTimers()
    const run = executeReviewRun({ ...runnerInput(root, snapshot, ['claims']), deps: { ...runnerInput(root, snapshot, ['claims']).deps, adapter } })
    await vi.runAllTimersAsync()
    const outcome = await run
    vi.useRealTimers()
    const record = outcome.records[0]!
    expect(record.errorCode).toBe('REVIEW_UNAVAILABLE')
    expect(record.errorDetail).toMatchObject({
      message: 'review dispatch failed: upstream unavailable',
      httpStatus: 503,
      providerCode: 'overloaded',
      retryAttempts: 2,
    })
  })
})

describe('cache reuse (§11.3)', () => {
  it('reuses a completed schema-valid record for identical inputs without a model call', async () => {
    const { root } = workspace()
    const claim = makeClaim('fact')
    const snapshot = makeSnapshot({ claims: [claim] })
    const adapter = fakeAdapter([() => ({ raw: claimsResponse(claim.id, 'pass') })])
    const sameRequestId = runnerInput(root, snapshot, ['claims']).requestId
    const first = await executeReviewRun({ ...runnerInput(root, snapshot, ['claims']), requestId: sameRequestId, deps: { ...runnerInput(root, snapshot, ['claims']).deps, adapter } })
    const before = adapter.state.dispatches
    // Resuming the SAME requestId reuses the saved completed task (§13); a
    // FRESH requestId is an explicit re-review and re-dispatches (D19 test).
    const second = await executeReviewRun({ ...runnerInput(root, snapshot, ['claims']), requestId: sameRequestId, deps: { ...runnerInput(root, snapshot, ['claims']).deps, adapter } })
    expect(adapter.state.dispatches).toBe(before) // reused, no new dispatch
    expect(completedRecord(second.records).response).toBeDefined()
    expect(first.records.length).toBe(1)
  })
})
