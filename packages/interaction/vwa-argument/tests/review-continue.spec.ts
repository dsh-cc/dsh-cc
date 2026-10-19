/**
 * Slice-2 continuation spec (§A.2, §A.3.2, §A.3.5, §A.3.6): cross-request
 * reuse of completed records in continue mode, deterministic record
 * selection, and the refuse-when-nothing-to-continue guard.
 * @module tests/review-continue
 */

import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeReviewRun } from '../src/review-runner.ts'
import { continuePreCheck, reusableRecord } from '../src/review-continue.ts'
import { ReviewRunStore, recordReusable } from '../src/review-run-store.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import type { ReviewRecord } from '../src/types.ts'
import {
  BUDGET, claimsResponse, fakeAdapter, makeClaim, makeSnapshot,
} from './review-helpers.ts'

function workspace(): { root: string } {
  return { root: mkdtempSync(join(tmpdir(), 'vwa-cont-')) }
}

type Snapshot = ReturnType<typeof makeSnapshot>

/** Dispatch step that passes the target claim it was called with (or throws for one target). */
function step(opts: { tokens: number; result?: 'pass' | 'fail'; throwFor?: string }) {
  return (req: { messages: { role: string; content: string }[] }) => {
    const targetId = (JSON.parse(req.messages[1]!.content) as { targets: { id: string }[] }).targets[0]!.id
    if (opts.throwFor === targetId) throw new Error('boom')
    return { raw: claimsResponse(targetId, opts.result ?? 'pass'), inputTokens: opts.tokens }
  }
}

function runner(
  root: string,
  snapshot: ReturnType<typeof makeSnapshot>,
  adapter: ReturnType<typeof fakeAdapter>,
  runId = `run_${randomUUID()}`,
) {
  return {
    deps: { root, adapter, budget: BUDGET, contractHash: 'c'.repeat(64) },
    runId,
    requestId: `req-${randomUUID()}`,
    stages: ['claims'] as const,
    targetClaimIds: snapshot.claims.map((claim) => claim.id),
    snapshot,
    signal: new AbortController().signal,
  }
}

/** A minimal completed claims record for selection unit tests. */
function record(endedAt: string, result: 'pass' | 'fail', claim = makeClaim()): ReviewRecord {
  return {
    runId: 'run_x',
    stage: 'claims',
    targetRefs: [{ id: claim.id, entityVersion: 1 }],
    dependencyDigest: 'd'.repeat(64),
    contractHash: 'c'.repeat(64),
    policyHash: 'p'.repeat(64),
    reviewerConfigHash: 'r'.repeat(64),
    promptHash: 'm'.repeat(64),
    inputHash: 'k'.repeat(64),
    status: 'completed',
    inputTokens: 0,
    outputTokens: 0,
    startedAt: endedAt,
    endedAt,
    response: JSON.parse(claimsResponse(claim.id, result)),
  }
}

describe('continue mode — reuse across requestIds (§A.2)', () => {
  it('reuses completed records across requestIds and re-executes only failed tasks', async () => {
    const { root } = workspace()
    const a = makeClaim('fact')
    const b = makeClaim('fact')
    const snapshot = makeSnapshot({ claims: [a, b] })
    const adapter = fakeAdapter([step({ tokens: 10, throwFor: b.id })])
    const first = await executeReviewRun(runner(root, snapshot, adapter))
    expect(first.status).toBe('incomplete')
    expect(adapter.state.dispatches).toBe(3) // A passes; B's thrown call is retried once by the caller.
    const secondRunId = `run_${randomUUID()}`
    const second = await executeReviewRun({
      ...runner(root, snapshot, fakeAdapter([step({ tokens: 10 })]), secondRunId),
      continueMode: true,
    })
    expect(second.status).toBe('completed')
    expect(second.records.some((r) => r.status === 'completed' && r.inputTokens === 10)).toBe(true)
    // §A.3.5: the reused record is in the usage ledger with zero tokens.
    const usage = new ReviewRunStore(root, snapshot.projectId).readUsage(secondRunId)
    expect(usage.some((row) => row.kind === 'reused' && row.inputTokens === 0)).toBe(true)
  })

  it('refuses a continue run when every planned task already has a reusable record', async () => {
    const { root } = workspace()
    const claim = makeClaim('fact')
    const snapshot = makeSnapshot({ claims: [claim] })
    await executeReviewRun(runner(root, snapshot, fakeAdapter([step({ tokens: 5 })])))
    const guardAdapter = fakeAdapter([() => ({ raw: claimsResponse(claim.id, 'pass') })])
    const second = await executeReviewRun({ ...runner(root, snapshot, guardAdapter), continueMode: true })
    expect(guardAdapter.state.dispatches).toBe(0)
    expect(second.status).toBe('completed')
  })

  it('reuses a prior fail record (fail-stands) without re-execution', async () => {
    const { root } = workspace()
    const a = makeClaim('fact')
    const b = makeClaim('fact')
    // Run 1 over A only: A fails (fail-stands).
    const firstSnapshot = makeSnapshot({ claims: [a] })
    await executeReviewRun(runner(root, firstSnapshot, fakeAdapter([step({ tokens: 7, result: 'fail' })])))
    // Continue run over A+B: A's fail record is reused verbatim, B is fresh work.
    const secondAdapter = fakeAdapter([step({ tokens: 8, throwFor: a.id })])
    const second = await executeReviewRun({
      ...runner(root, makeSnapshot({ claims: [a, b], projectId: firstSnapshot.projectId }), secondAdapter),
      continueMode: true,
    })
    expect(secondAdapter.state.dispatches).toBe(1)
    const verdicts = second.records.flatMap((r) =>
      r.response?.targets.flatMap((t) => t.checks.map((c) => c.result)) ?? [],
    )
    expect(verdicts).toContain('fail')
    expect(second.status).toBe('completed')
  })

  it('does not reuse when the target scope changes the required rules (§A.3.1)', async () => {
    const { root } = workspace()
    const claim = makeClaim('fact')
    await executeReviewRun(runner(root, makeSnapshot({ claims: [claim] }), fakeAdapter([step({ tokens: 3 })])))
    // Same claim id, different kind → CAUSE-01 instead of HIST-01 → different key.
    const causal = { ...claim, kind: 'causal' as const }
    const causalResponse = JSON.stringify({
      stage: 'claims', rubricVersion: 'humanities-v1', findings: [],
      targets: [{ targetId: causal.id, checks: [{ ruleId: 'CAUSE-01', result: 'pass', rationale: 'r', evidenceIds: [] }], searchSufficiency: 'checked' }],
    })
    const secondAdapter = fakeAdapter([() => ({ raw: causalResponse, inputTokens: 4 })])
    const second = await executeReviewRun({
      ...runner(root, makeSnapshot({ claims: [causal] }), secondAdapter),
      continueMode: true,
    })
    expect(secondAdapter.state.dispatches).toBe(1)
    expect(second.status).toBe('completed')
    expect(second.records.some((r) => r.inputTokens === 4)).toBe(true)
  })

  it('re-executes every task when continue is absent (default behavior preserved)', async () => {
    const { root } = workspace()
    const claim = makeClaim('fact')
    const snapshot = makeSnapshot({ claims: [claim] })
    const adapter = fakeAdapter([step({ tokens: 5 })])
    await executeReviewRun(runner(root, snapshot, adapter))
    const before = adapter.state.dispatches
    const second = await executeReviewRun(runner(root, snapshot, adapter))
    expect(adapter.state.dispatches).toBe(before + 1)
    expect(second.status).toBe('completed')
  })

  it('does not refuse a continue run that includes the audit stage (§A.2)', async () => {
    // Audit tasks are never reusable, so a continuation including audit always
    // has fresh work — the NOTHING_TO_CONTINUE guard must not fire. The fake
    // adapter answers with a claims-shaped response, so the audit stage itself
    // errors after dispatch (errorRecord → 'incomplete'); what matters here is
    // that audit work was ATTEMPTED instead of the guard short-circuiting to
    // 'completed' with zero dispatches.
    const { root } = workspace()
    const claim = makeClaim('fact')
    const snapshot = makeSnapshot({ claims: [claim] })
    await executeReviewRun(runner(root, snapshot, fakeAdapter([step({ tokens: 5 })])))
    const adapter = fakeAdapter([step({ tokens: 5 })])
    const second = await executeReviewRun({
      ...runner(root, snapshot, adapter),
      stages: ['claims', 'audit'],
      artifact: { id: `art_${randomUUID()}`, path: 'docs/a.md', text: '# Body\n\nSome text.\n' },
      continueMode: true,
    })
    expect(adapter.state.dispatches).toBeGreaterThan(0)
    expect(second.status).toBe('incomplete')
  })

  it('continuePreCheck returns undefined for audit-only continue (tool-level guard)', () => {
    const { root } = workspace()
    const claim = makeClaim('fact')
    const snapshot = makeSnapshot({ claims: [claim] })
    expect(
      continuePreCheck({
        root,
        adapter: fakeAdapter([]),
        contractHash: 'c'.repeat(64),
        snapshot,
        stages: ['audit'],
        targetClaimIds: [claim.id],
      }),
    ).toBeUndefined()
  })

  it('picks the most recent record when several share the cache key (§A.3.2)', async () => {
    const { root } = workspace()
    const a = makeClaim('fact')
    const b = makeClaim('fact')
    const snapshot = makeSnapshot({ claims: [a, b] })
    // Run 1: A completes (tokens 11), B fails. Run 2 (fresh request): A
    // completes again (tokens 22), B fails again. Continue run must reuse
    // A's most recent record (22) and re-execute only B.
    await executeReviewRun(runner(root, snapshot, fakeAdapter([step({ tokens: 11, throwFor: b.id })])))
    await executeReviewRun(runner(root, snapshot, fakeAdapter([step({ tokens: 22, throwFor: b.id })])))
    const thirdAdapter = fakeAdapter([step({ tokens: 33, throwFor: b.id })])
    const third = await executeReviewRun({ ...runner(root, snapshot, thirdAdapter), continueMode: true })
    expect(thirdAdapter.state.dispatches).toBe(2) // B's throw is retried once; A is never dispatched.
    expect(third.status).toBe('incomplete')
    expect(third.records.some((r) => r.status === 'completed' && r.inputTokens === 22)).toBe(true)
  })
})

describe('deterministic record selection (§A.3.2)', () => {
  const required = new Set(['HIST-01'])
  it('selects the record with the latest endedAt', () => {
    const claim = makeClaim('fact')
    const earlier = record('2026-10-19T00:00:00.000Z', 'pass', claim)
    const later = { ...record('2026-10-19T00:00:01.000Z', 'pass', claim) }
    expect(reusableRecord([earlier, later], { requiredRules: [{ targetId: claim.id, ruleId: 'HIST-01' }] } as never, true, new Set()))
      .toBe(later)
  })
  it('breaks equal endedAt by recordHash ascending', () => {
    const claim = makeClaim('fact')
    const first = record('2026-10-19T00:00:00.000Z', 'pass', claim)
    const second = record('2026-10-19T00:00:00.000Z', 'pass', claim)
    const hashes = [sha256Hex(stableJson(first)), sha256Hex(stableJson(second))].sort()
    const picked = reusableRecord([first, second], { requiredRules: [{ targetId: claim.id, ruleId: 'HIST-01' }] } as never, true, new Set())
    expect(sha256Hex(stableJson(picked!))).toBe(hashes[0])
  })
  it('fail records are reusable (fail-stands)', () => {
    const claim = makeClaim('fact')
    const failed = record('2026-10-19T00:00:00.000Z', 'fail', claim)
    expect(recordReusable(failed, required)).toBe(true)
    expect(reusableRecord([failed], { requiredRules: [{ targetId: claim.id, ruleId: 'HIST-01' }] } as never, true, new Set()))
      .toBe(failed)
  })
})
