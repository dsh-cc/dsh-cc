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
import { ReviewRunStore, cacheKey, recordReusable } from '../src/review-run-store.ts'
import { activeMajorCount } from '../src/policy.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import { taskEnvelope } from '../src/review-input.ts'
import type { ReviewRecord, ReviewTask } from '../src/types.ts'
import {
  BUDGET, claimsResponse, completedRecord, fakeAdapter, makeClaim, makeSnapshot, makeSource, type FakeAdapterState,
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
  it('persists zero audit attempts when an earlier stage succeeded but the artifact is refused', async () => {
    const { root } = workspace()
    const claim = makeClaim('fact')
    const snapshot = makeSnapshot({ claims: [claim] })
    const adapter = fakeAdapter([() => ({ raw: claimsResponse(claim.id, 'pass') })])
    const input = runnerInput(root, snapshot, ['claims'])
    const outcome = await executeReviewRun({
      ...input, stages: ['claims', 'audit'],
      artifact: { id: `art_${randomUUID()}`, path: 'docs/a.md', text: 'oversized' },
      deps: { ...input.deps, adapter, maxArtifactChars: 1 },
    })
    expect(adapter.state.dispatches).toBe(1)
    expect(outcome.records[0]?.status).toBe('completed')
    const expected = { stage: 'audit', errorCode: 'REVIEW_INVALID', errorDetail: { retryAttempts: 0 } }
    expect(outcome.records.at(-1)).toMatchObject(expected)
    const saved = new ReviewRunStore(root, snapshot.projectId).readRecords(input.runId)
    expect(saved.find((record) => record.stage === 'audit')).toMatchObject(expected)
  })

  it('persists two attempts when the host cancels the second dispatch with a string reason', async () => {
    const { root } = workspace()
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const adapter = fakeAdapter([() => ({ raw: '{' }), () => new Promise<never>(() => {})])
    const controller = new AbortController()
    const input = runnerInput(root, snapshot, ['claims'])
    vi.useFakeTimers()
    try {
      const pending = executeReviewRun({
        ...input, signal: controller.signal, deps: { ...input.deps, adapter },
      })
      await vi.advanceTimersByTimeAsync(1500)
      expect(adapter.state.dispatches).toBe(2)
      controller.abort('review cancelled')
      const outcome = await pending
      expect(outcome.status).toBe('cancelled')
      const expected = {
        errorCode: 'CANCELLED', errorDetail: { message: 'review cancelled', retryAttempts: 2 },
      }
      expect(outcome.records[0]).toMatchObject(expected)
      const saved = new ReviewRunStore(root, snapshot.projectId).readRecords(input.runId)
      expect(saved[0]).toMatchObject(expected)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['initialize', 'snapshot', 'cancelled'] as const)('records a %s failure at run level without fabricating a stage record', async (failure) => {
    const { root } = workspace()
    const source = makeSource()
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')], sources: [source] })
    const adapter = fakeAdapter([() => ({ raw: '{}' })])
    adapter.initialize = async () => {
      if (failure === 'initialize') throw new Error('review route unavailable')
    }
    const input = runnerInput(root, snapshot, ['claims'])
    if (failure === 'cancelled') input.signal = AbortSignal.abort(new Error('cancelled before start'))
    const outcome = await executeReviewRun({ ...input, deps: {
      ...input.deps, adapter, readSnapshot: () => undefined,
    } })
    expect(adapter.state.dispatches).toBe(0)
    // Startup failures never entered a stage, so no task failed: the reason
    // lives on the run-level refusal, not on a stage error record.
    expect(outcome.records).toHaveLength(0)
    expect(outcome.status).toBe(failure === 'cancelled' ? 'cancelled' : 'incomplete')
    expect(outcome.refusal?.code).toBe({
      initialize: 'REVIEW_UNAVAILABLE', snapshot: 'REVIEW_INVALID', cancelled: 'CANCELLED',
    }[failure])
    const saved = new ReviewRunStore(root, snapshot.projectId).readRecords(input.runId)
    expect(saved).toHaveLength(0)
  })

  it('does not attribute a startup validation failure to the audit stage', async () => {
    const { root } = workspace()
    const source = makeSource()
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')], sources: [source] })
    const adapter = fakeAdapter([() => ({ raw: '{}' })])
    const input = { ...runnerInput(root, snapshot, ['sources']), stages: ['sources', 'support', 'claims', 'arguments', 'audit'] as import('../src/types.ts').ReviewStage[] }
    const outcome = await executeReviewRun({ ...input, deps: {
      ...input.deps, adapter, readSnapshot: () => undefined,
    } })
    expect(adapter.state.dispatches).toBe(0)
    // Before the fix this fabricated an audit error record with full artifact
    // identity, so report progress showed audit total=1 failed=1 although the
    // audit never started (model calls: 0).
    expect(outcome.records).toHaveLength(0)
    expect(outcome.records.some((record) => record.stage === 'audit')).toBe(false)
    expect(outcome.status).toBe('incomplete')
    expect(outcome.refusal?.code).toBe('REVIEW_INVALID')
    expect(outcome.refusal?.message).toContain('snapshot missing or changed')
  })

  it.each([0, 2])('persists %i completed attempts when input counting fails', async (attempts) => {
    const { root } = workspace()
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const adapter = fakeAdapter([() => ({ raw: '{' })])
    const count = adapter.countInput.bind(adapter)
    adapter.countInput = async (messages) => {
      if (adapter.state.dispatches === attempts) throw new Error('tokenizer unavailable')
      return count(messages)
    }
    const input = runnerInput(root, snapshot, ['claims'])
    vi.useFakeTimers()
    try {
      const pending = executeReviewRun({ ...input, deps: { ...input.deps, adapter } })
      await vi.runAllTimersAsync()
      const outcome = await pending
      const expected = {
        errorCode: 'REVIEW_UNAVAILABLE',
        errorDetail: { message: 'tokenizer unavailable', retryAttempts: attempts },
      }
      expect(adapter.state.dispatches).toBe(attempts)
      expect(outcome.records[0]).toMatchObject(expected)
      const saved = new ReviewRunStore(root, snapshot.projectId).readRecords(input.runId)
      expect(saved[0]).toMatchObject(expected)
    } finally {
      vi.useRealTimers()
    }
  })

  it('persists zero attempts for a context refusal before dispatch', async () => {
    const { root } = workspace()
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const adapter = fakeAdapter([() => ({ raw: '{}' })])
    const input = runnerInput(root, snapshot, ['claims'])
    const outcome = await executeReviewRun({ ...input, deps: { ...input.deps, adapter, maxContextChars: 1 } })
    expect(adapter.state.dispatches).toBe(0)
    expect(outcome.records[0]).toMatchObject({
      errorCode: 'CONTEXT_TOO_LARGE', errorDetail: { retryAttempts: 0 },
    })
    const saved = new ReviewRunStore(root, snapshot.projectId).readRecords(input.runId)
    expect(saved[0]?.errorDetail?.retryAttempts).toBe(0)
  })

  it('persists the actual attempts when the next retry exceeds the budget', async () => {
    const { root } = workspace()
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const adapter = fakeAdapter([() => ({ raw: '{' })])
    const input = runnerInput(root, snapshot, ['claims'])
    vi.useFakeTimers()
    try {
      const run = executeReviewRun({ ...input, deps: {
        ...input.deps, adapter, budget: { ...BUDGET, maxCallsPerRun: 2 },
      } })
      await vi.runAllTimersAsync()
      const outcome = await run
      expect(adapter.state.dispatches).toBe(2)
      expect(outcome.records[0]).toMatchObject({
        errorCode: 'BUDGET_EXHAUSTED', errorDetail: { retryAttempts: 2 },
      })
      const saved = new ReviewRunStore(root, snapshot.projectId).readRecords(input.runId)
      expect(saved[0]?.errorDetail?.retryAttempts).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

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

describe('cacheKey requiredRules extension (§A.3.1)', () => {
  const base = {
    stage: 'sources',
    targetRefs: [{ id: 'src_x', entityVersion: 1 }],
    dependencyDigest: 'd'.repeat(64),
    contractHash: 'c'.repeat(64),
    policyHash: 'p'.repeat(64),
    reviewerConfigHash: 'r'.repeat(64),
    promptHash: 'm'.repeat(64),
  }
  it('differing requiredRules yield different keys', () => {
    const a = cacheKey({ ...base, requiredRules: [{ targetId: 'src_x', ruleId: 'SOURCE-01' }] })
    const b = cacheKey({ ...base, requiredRules: [{ targetId: 'src_x', ruleId: 'SOURCE-03' }] })
    expect(b).not.toBe(a)
  })
  it('order-permuted equal requiredRules yield the same key', () => {
    const a = cacheKey({
      ...base,
      requiredRules: [
        { targetId: 'src_x', ruleId: 'SOURCE-01' },
        { targetId: 'src_y', ruleId: 'SOURCE-02' },
      ],
    })
    const b = cacheKey({
      ...base,
      requiredRules: [
        { targetId: 'src_y', ruleId: 'SOURCE-02' },
        { targetId: 'src_x', ruleId: 'SOURCE-01' },
      ],
    })
    expect(b).toBe(a)
  })
})

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

describe('Feature C — claims batching (§C.2.2/§C.2.3)', () => {
  function batchedFixture() {
    const { root } = workspace()
    const claims = [makeClaim('fact'), makeClaim('fact'), makeClaim('fact')]
    const snapshot = makeSnapshot({
      claims,
      contract: {
        ...makeSnapshot().contract,
        reviewSettings: { budget: BUDGET, maxArtifactChars: 120_000, maxContextChars: 48_000, claimsBatchSize: 2 },
      },
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
    const run = (continueMode = false, requestId?: string) =>
      executeReviewRun({
        deps: { root, adapter, budget: BUDGET, contractHash: 'c'.repeat(64) },
        runId: `run_${randomUUID()}`,
        requestId: requestId ?? `req-${Math.random()}`,
        stages: ['claims'],
        targetClaimIds: claims.map((c) => c.id),
        snapshot,
        signal: new AbortController().signal,
        ...(continueMode ? { continueMode: true } : {}),
      })
    return { snapshot, adapter, run }
  }

  it('runs one adapter call per batch; records carry multi-target targetRefs', async () => {
    const f = batchedFixture()
    const outcome = await f.run()
    expect(outcome.status).toBe('completed')
    expect(f.adapter.state.dispatches).toBe(2) // 3 claims, batch 2 → 2 tasks
    expect(outcome.records.filter((r) => r.status === 'completed')).toHaveLength(2)
    expect(outcome.records[0]!.targetRefs).toHaveLength(2)
    expect(outcome.records[0]!.response?.targets).toHaveLength(2)
  })

  it('continue mode with batching reuses the batched records and dispatches nothing', async () => {
    const f = batchedFixture()
    const first = await f.run(false, 'req-batch')
    expect(first.status).toBe('completed')
    const before = f.adapter.state.dispatches
    const second = await f.run(true, 'req-batch-2')
    // §C.2.1 continue exemption: every planned task is reusable → the run
    // reuses everything and no new call is dispatched.
    expect(second.status).toBe('completed')
    expect(f.adapter.state.dispatches).toBe(before)
  })
})

/** A schema-valid sources response covering the source rules the task required. */
function sourcesStageResponse(sourceId: string, result: 'pass'): string {
  return JSON.stringify({
    stage: 'sources',
    rubricVersion: 'humanities-v1',
    findings: [],
    targets: [{
      targetId: sourceId,
      checks: [
        { ruleId: 'SOURCE-01', result, rationale: 'provenance visible in the windowed head', evidenceIds: [] },
        { ruleId: 'SOURCE-02', result, rationale: 'r', evidenceIds: [] },
      ],
    }],
  })
}

describe('Feature E — large-source compaction in the runner', () => {
  const SENTENCE = 'The committee recorded its decision after long deliberation on the matter. '
  const MIDDLE = 'THIS-SENTENCE-SITS-IN-THE-OMITTED-MIDDLE. '

  function sourcesTask(source: ReturnType<typeof makeSource>): ReviewTask {
    return {
      taskId: 'task_e2e',
      stage: 'sources',
      targetRefs: [{ id: source.id, entityVersion: source.entityVersion }],
      targetIds: [source.id],
      requiredRules: [
        { targetId: source.id, ruleId: 'SOURCE-01' },
        { targetId: source.id, ruleId: 'SOURCE-02' },
      ],
      envelope: {},
    }
  }

  function citedClaim(source: { id: string }) {
    return { ...makeClaim('fact'), scope: { ...makeClaim('fact').scope, corpus: [source.id] } }
  }

  function runSources(root: string, adapter: ReturnType<typeof fakeAdapter>, snapshot: ProjectSnapshot_, source: { id: string }, text: string, claim: { id: string }) {
    return executeReviewRun({
      deps: { root, adapter, budget: BUDGET, contractHash: 'c'.repeat(64), readSnapshot: () => text },
      runId: `run_${randomUUID()}`,
      requestId: `req-${Math.random()}`,
      stages: ['sources'],
      targetClaimIds: [claim.id],
      snapshot,
      signal: new AbortController().signal,
    })
  }

  it('a ~200KB prose source is windowed in the sources envelope, not sent in full', () => {
    const text = SENTENCE + MIDDLE.repeat(2400) + 'THE-UNIQUE-OMITTED-TOKEN. ' + MIDDLE.repeat(2390) + SENTENCE
    expect(text.length).toBeGreaterThan(200_000)
    const { root } = workspace()
    const source = { ...makeSource(), snapshotHash: sha256Hex(text) }
    const snapshot = makeSnapshot({ sources: [source], claims: [citedClaim(source)] })
    const envelope = taskEnvelope({
      stage: 'sources',
      runId: 'run_e2e',
      task: sourcesTask(source),
      snapshot,
      records: [],
      maxOutputTokens: BUDGET.maxOutputTokensPerCall,
      maxContextChars: 48_000,
      readSnapshot: () => text,
    })
    const serialized = stableJson(envelope) as string
    // The dispatch fits the context limit and windowing is disclosed.
    expect(serialized.length).toBeLessThanOrEqual(48_000)
    expect(serialized).toContain('chars omitted ...]')
    expect(serialized).not.toContain('THE-UNIQUE-OMITTED-TOKEN.')
    expect(serialized.length).toBeLessThan(text.length)
    const sources = (envelope as { context: { sources: { text: string; windowing?: object }[] } }).context.sources
    expect(sources[0]!.windowing).toBeDefined()
    // The head carries the provenance-bearing start.
    expect(sources[0]!.text.startsWith(SENTENCE)).toBe(true)
    void root
  })

  it('a ~200KB prose source completes a full runner dispatch at the default context budget', async () => {
    const text = SENTENCE + MIDDLE.repeat(4800) + SENTENCE
    const { root } = workspace()
    const source = { ...makeSource(), snapshotHash: sha256Hex(text) }
    const claim = citedClaim(source)
    const snapshot = makeSnapshot({ sources: [source], claims: [claim] })
    const adapter = fakeAdapter([() => ({ raw: sourcesStageResponse(source.id, 'pass') })])
    // The windowing budget reserves the stage prompt's headroom, so the
    // windowed envelope plus system prompt fits the caller's whole-message
    // check at the default 48K limit and the dispatch completes.
    const outcome = await runSources(root, adapter, snapshot, source, text, claim)
    expect(outcome.status).toBe('completed')
    const record = completedRecord(outcome.records)
    expect(record.stage).toBe('sources')
    expect(record.status).toBe('completed')
  })

  it('repairs a windowed source response within the whole-message context budget', async () => {
    const text = SENTENCE.repeat(3000)
    const { root } = workspace()
    const source = { ...makeSource(), snapshotHash: sha256Hex(text) }
    const claim = citedClaim(source)
    const snapshot = makeSnapshot({ sources: [source], claims: [claim] })
    const requests: Array<Array<{ role: string; content: string }>> = []
    const adapter = fakeAdapter([
      ({ messages }) => { requests.push(messages); return { raw: '{' } },
      ({ messages }) => { requests.push(messages); return { raw: sourcesStageResponse(source.id, 'pass') } },
    ])
    vi.useFakeTimers()
    try {
      const pending = runSources(root, adapter, snapshot, source, text, claim)
      await vi.runAllTimersAsync()
      const outcome = await pending
      expect(outcome.status).toBe('completed')
      expect(adapter.state.dispatches).toBe(2)
      expect(requests[1]!.slice(0, -1)).toEqual(requests[0])
      expect(requests[1]!.at(-1)!.content).toContain('previous response was invalid')
      expect(JSON.parse(requests[0]![1]!.content).context.sources[0].windowing).toBeDefined()
      for (const messages of requests)
        expect(messages.reduce((chars, message) => chars + message.content.length, 0)).toBeLessThanOrEqual(48_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a structured source larger than the limit finishes incomplete without dispatching', async () => {
    const text = JSON.stringify({ rows: Array.from({ length: 4000 }, (_, i) => ({ id: i, note: 'x'.repeat(60) })) })
    const { root } = workspace()
    const source = { ...makeSource(), snapshotHash: sha256Hex(text) }
    const claim = citedClaim(source)
    const snapshot = makeSnapshot({ sources: [source], claims: [claim] })
    const adapter = fakeAdapter([() => ({ raw: sourcesStageResponse(source.id, 'pass') })])
    const outcome = await runSources(root, adapter, snapshot, source, text, claim)
    // The envelope refuses structured data before any dispatch; the failure
    // lands as an error record and the run finishes incomplete.
    expect(outcome.status).toBe('incomplete')
    expect(adapter.state.dispatches).toBe(0)
    expect(outcome.records.filter((r) => r.status === 'completed')).toHaveLength(0)
    const errorRecords = outcome.records.filter((r) => r.status === 'error')
    expect(errorRecords).toHaveLength(1)
    expect(errorRecords[0]!.errorCode).toBe('CONTEXT_TOO_LARGE')
    // The envelope-construction error itself carries the derived-source pointer.
    try {
      taskEnvelope({
        stage: 'sources',
        runId: 'run_e2e',
        task: sourcesTask(source),
        snapshot,
        records: [],
        maxOutputTokens: BUDGET.maxOutputTokensPerCall,
        maxContextChars: 48_000,
        readSnapshot: () => text,
      })
      expect.unreachable('taskEnvelope must reject structured data over the limit')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('CONTEXT_TOO_LARGE')
      expect((error as Error).message).toContain('Register a distilled companion source')
    }
  })
})

describe('F1.4 — retry pool seeded from the request record', () => {
  /** Pre-write a queued request record (the runner reads retryAllowance from it). */
  function seedRequest(root: string, projectId: string, input: ReturnType<typeof runnerInput>, retryAllowance?: number): void {
    new ReviewRunStore(root, projectId).writeRequest(input.runId, {
      schemaVersion: 1,
      requestId: input.requestId,
      runId: input.runId,
      stage: input.stages.join('+'),
      targetClaimIds: [],
      status: 'queued',
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      startedAt: new Date().toISOString(),
      ...(retryAllowance === undefined ? {} : { retryAllowance }),
    })
  }

  it('exhausted pool fails the task REVIEW_RETRY_BUDGET with the refusal persisted on the run outcome (allSettled path)', async () => {
    const { root } = workspace()
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const adapter = fakeAdapter([() => ({ raw: '{' })])
    const input = runnerInput(root, snapshot, ['claims'])
    seedRequest(root, snapshot.projectId, input, 1)
    vi.useFakeTimers()
    const run = executeReviewRun({ ...input, deps: { ...input.deps, adapter } })
    await vi.runAllTimersAsync()
    const outcome = await run
    vi.useRealTimers()
    expect(outcome.status).toBe('incomplete')
    expect(outcome.refusal).toMatchObject({ code: 'REVIEW_RETRY_BUDGET' })
    expect(outcome.refusal?.message).toContain('retry headroom exhausted')
    expect(outcome.refusal?.message).toContain('continue: true')
    const record = outcome.records[0]!
    expect(record.errorCode).toBe('REVIEW_RETRY_BUDGET')
    expect(record.status).toBe('error')
  })

  it('the outer-catch failure path persists the refusal too (audit stage)', async () => {
    const { root } = workspace()
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    // Audit extract stays invalid: the per-call ceiling would allow 3 attempts,
    // but the pool of 1 runs out after the first retry.
    const adapter = fakeAdapter([() => ({ raw: '{' })])
    const input = runnerInput(root, snapshot, ['audit'])
    seedRequest(root, snapshot.projectId, input, 1)
    vi.useFakeTimers()
    const run = executeReviewRun({
      ...input,
      artifact: { id: `art_${randomUUID()}`, path: 'docs/a.md', text: 'audit body' },
      deps: { ...input.deps, adapter },
    })
    await vi.runAllTimersAsync()
    const outcome = await run
    vi.useRealTimers()
    expect(outcome.status).toBe('incomplete')
    expect(outcome.refusal).toMatchObject({ code: 'REVIEW_RETRY_BUDGET' })
    expect(outcome.records.at(-1)).toMatchObject({ stage: 'audit', errorCode: 'REVIEW_RETRY_BUDGET' })
  })

  it('a request record WITHOUT retryAllowance behaves as today (legacy unlimited)', async () => {
    const { root } = workspace()
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const adapter = fakeAdapter([() => ({ raw: '{' })])
    const input = runnerInput(root, snapshot, ['claims'])
    seedRequest(root, snapshot.projectId, input)
    vi.useFakeTimers()
    const run = executeReviewRun({ ...input, deps: { ...input.deps, adapter } })
    await vi.runAllTimersAsync()
    const outcome = await run
    vi.useRealTimers()
    expect(outcome.refusal).toBeUndefined()
    expect(outcome.records[0]).toMatchObject({ status: 'error', errorCode: 'REVIEW_INVALID' })
  })
})

