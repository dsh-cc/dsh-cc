/**
 * Slice 3 — end-to-end identity pin (§3 first bullet of
 * docs/plans/2026-10-21-vwa-review-settings-revision.md): a budget-exhausted
 * MID-PLAN run, a set-review-settings budget revision, and a continue run
 * must reuse every completed record (semantic stages AND audit) and report
 * currentness through delivery and progress. Also pins the claimsBatchSize
 * reshape semantics (§F3.3) and the one-time upgrade invalidation (§F3.2).
 * @module tests/review-identity-pin
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildReverseIndex } from '../src/dependencies.ts'
import { evaluateDelivery } from '../src/delivery-check.ts'
import { applyMutation, GraphContext } from '../src/graph.ts'
import { allRecords, continueHasWork, frozenCoreSet, planContinueTasks } from '../src/review-continue.ts'
import { computeStageProgress } from '../src/review-progress.ts'
import { policyHash, promptHash, recordMatchesKey, semanticContractHash } from '../src/review-contract.ts'
import { taskDependencyDigest } from '../src/review-input.ts'
import { recordReusable } from '../src/review-run-store.ts'
import { freezeReviewSettings } from '../src/review-config.ts'
import { afterRevisionCommit } from '../src/review-settings-revision.ts'
import { ReviewRunStore, cacheKey } from '../src/review-run-store.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import { runReviewWithTimers as executeReviewRun } from './review-timer-helpers.ts'
import type { ReviewStage } from '../src/review-plan.ts'
import {
  BUDGET, claimsResponse, fakeAdapter, makeClaim, makeSnapshot, NOW,
} from './review-helpers.ts'
import type { FrozenReviewSettings } from '../src/review-config.ts'
import type { ProjectSnapshot, ReviewRecord } from '../src/types.ts'

const STAGES: ReviewStage[] = ['claims', 'audit']

function settings(over: Partial<FrozenReviewSettings> = {}): FrozenReviewSettings {
  return {
    ...freezeReviewSettings(),
    claimsBatchSize: 1,
    // Keep maxOutputTokensPerRun within the FrozenReviewSettings schema range
    // so a set-review-settings revision over the merged result validates.
    budget: { ...BUDGET, maxCallsPerRun: 1, maxOutputTokensPerRun: 100_000 },
    ...over,
  }
}

function fixture(claims = [makeClaim('fact'), makeClaim('fact')], over: Partial<FrozenReviewSettings> = {}) {
  const artifact = { id: `art_${randomUUID()}`, path: 'a.md', text: 'A fact.' }
  const snapshot = makeSnapshot({
    contract: { ...makeSnapshot().contract, reviewSettings: settings(over) },
    claims,
    artifacts: [{
      id: artifact.id, path: artifact.path, entityVersion: 1,
      createdAt: NOW, updatedAt: NOW, contentHash: sha256Hex(artifact.text),
      outline: [], occurrences: [],
    }],
  })
  const root = mkdtempSync(join(tmpdir(), 'vwa-identity-pin-'))
  const base = {
    root, snapshot, artifact,
    stages: STAGES, targetClaimIds: claims.map((c) => c.id),
    signal: new AbortController().signal,
  }
  return { root, snapshot, artifact, base, claims }
}

/** Claims-only base for the batch-shape specs: no artifact, no audit stage. */
function claimsOnly(f: ReturnType<typeof fixture>) {
  return {
    ...f,
    base: { ...f.base, stages: ['claims' as ReviewStage], artifact: undefined },
  }
}

/** Revise the frozen settings through the real mutation op (F3.3) and run the F3.4 post-commit hook. */
function revise(root: string, snapshot: ProjectSnapshot, patch: object): ProjectSnapshot {
  const graph = new GraphContext(structuredClone(snapshot), 10_000)
  const outcome = applyMutation(graph, { op: 'set-review-settings', reviewSettings: patch } as never)
  expect(outcome.contractChanged).toBe(false)
  afterRevisionCommit(root, snapshot.projectId, 'set-review-settings', { ok: true, data: outcome })
  return graph.snapshot
}

function auditSteps(artifactId: string) {
  return [
    () => ({ raw: JSON.stringify({ items: [] }), inputTokens: 5 }),
    (req: { messages: { content: string }[] }) => ({ raw: JSON.stringify({
      stage: 'align', rubricVersion: 'humanities-v1', findings: [], alignment: [],
      targets: [{ targetId: artifactId, checks: JSON.parse(req.messages[1]!.content).requiredRules
        .map((r: { ruleId: string }) => ({ ruleId: r.ruleId, result: 'pass', rationale: 'reviewed', evidenceIds: [] })) }],
    }), inputTokens: 5 }),
  ]
}

describe('end-to-end identity pin: budget revision preserves completed-record reuse', () => {
  it('revises the budget upward mid-plan; the continue run reuses completed records and reports currentness', async () => {
    const f = fixture()
    const first = await executeReviewRun({
      ...f.base,
      runId: `run_${randomUUID()}`, requestId: randomUUID(),
      deps: {
        root: f.root, contractHash: semanticContractHash(f.snapshot.contract),
        adapter: fakeAdapter([(req) => ({ raw: claimsResponse(JSON.parse(req.messages[1]!.content).targets[0].id, 'pass'), inputTokens: 5 })]),
        budget: f.snapshot.contract.reviewSettings!.budget,
      },
    })
    // Budget-exhausted MID-PLAN: one claims record completed, work pending.
    expect(first.status).toBe('budget-exhausted')
    const completed = first.records.filter((r) => r.status === 'completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]!.stage).toBe('claims')

    const revisedSnapshot = revise(f.root, f.snapshot, { budget: { maxCallsPerRun: 10 } })
    expect(semanticContractHash(revisedSnapshot.contract)).toBe(semanticContractHash(f.snapshot.contract))
    const secondAdapter = fakeAdapter([
      (req) => ({ raw: claimsResponse(JSON.parse(req.messages[1]!.content).targets[0].id, 'pass'), inputTokens: 5 }),
      ...auditSteps(f.artifact.id),
    ])
    const second = await executeReviewRun({
      ...f.base, snapshot: revisedSnapshot,
      runId: `run_${randomUUID()}`, requestId: randomUUID(), continueMode: true,
      deps: {
        root: f.root, adapter: secondAdapter, budget: revisedSnapshot.contract.reviewSettings!.budget,
        contractHash: semanticContractHash(revisedSnapshot.contract),
      },
    })
    expect(second.status).toBe('completed')
    // Exactly the PENDING work dispatched: claim b's claims task + extract + align.
    // The completed claims record from run 1 was reused — zero re-dispatch.
    expect(secondAdapter.state.dispatches).toBe(3)
    const usage = new ReviewRunStore(f.root, f.snapshot.projectId).readUsage(second.runId)
    const reusedRows = usage.filter((row) => row.kind === 'reused')
    expect(reusedRows.length).toBeGreaterThanOrEqual(1)
    expect(reusedRows.every((row) => row.inputTokens === 0 && row.outputTokens === 0)).toBe(true)
    const history = allRecords(f.root, f.snapshot.projectId)
    // The reused claim-a record was not re-executed: the continue run carries
    // a copy of run 1's completed record under its own runId (same identity),
    // and the zero-token charge lives in the usage ledger (asserted above).
    const copied = second.records.filter((r) => r.stage === 'claims' &&
      r.targetRefs.some((ref) => ref.id === f.claims[0]!.id))
    expect(copied).toHaveLength(1)
    expect(copied[0]!.inputHash).toBe(completed[0]!.inputHash)

    // Continue-mode audit reuse (Fix 1 F1.2): an audit-only continuation over
    // the completed run reuses the extract/align pair — zero dispatches.
    const auditOnlyAdapter = fakeAdapter(auditSteps(f.artifact.id))
    const auditOnly = await executeReviewRun({
      ...f.base, snapshot: revisedSnapshot, stages: ['audit'],
      runId: `run_${randomUUID()}`, requestId: randomUUID(), continueMode: true,
      deps: {
        root: f.root, adapter: auditOnlyAdapter, budget: revisedSnapshot.contract.reviewSettings!.budget,
        contractHash: semanticContractHash(revisedSnapshot.contract),
      },
    })
    expect(auditOnlyAdapter.state.dispatches).toBe(0)
    expect(auditOnly.refusal).toMatchObject({ code: 'NOTHING_TO_CONTINUE' })

    // Delivery and progress report CURRENTNESS over the reused records — a
    // missed comparison site would fail loudly here, not just in the ledger.
    const report = evaluateDelivery({
      root: f.root, snapshot: revisedSnapshot, artifactId: f.artifact.id, text: f.artifact.text,
      records: allRecords(f.root, f.snapshot.projectId), pendingRunIds: [], adjudications: [],
    })
    expect(report.checks.audit).toBe('pass')
    const index = buildReverseIndex(revisedSnapshot)
    const progress = computeStageProgress({
      snapshot: revisedSnapshot, index,
      core: frozenCoreSet({ root: f.root, index, snapshot: revisedSnapshot, artifact: { id: f.artifact.id, text: f.artifact.text } }),
      targets: f.claims.map((c) => c.id),
      records: allRecords(f.root, f.snapshot.projectId),
      claimsBatchSize: revisedSnapshot.contract.reviewSettings!.claimsBatchSize,
      artifact: { id: f.artifact.id, text: f.artifact.text },
    })
    expect(progress.stageProgress.claims).toMatchObject({ total: 2, completed: 2, notRun: 0 })
    expect(progress.stageProgress.audit.completed).toBe(1)
  })
})

describe('claimsBatchSize reshape (§F3.3)', () => {
  it('same-shape reuse: a budget-only revision keeps completed claims records matching (nothing to continue)', async () => {
    const f = claimsOnly(fixture(undefined, { budget: { ...BUDGET, maxCallsPerRun: 10, maxOutputTokensPerRun: 100_000 } }))
    const run = await executeReviewRun({
      ...f.base,
      runId: `run_${randomUUID()}`, requestId: randomUUID(),
      deps: {
        root: f.root, contractHash: semanticContractHash(f.snapshot.contract),
        adapter: fakeAdapter([(req) => ({ raw: claimsResponse(JSON.parse(req.messages[1]!.content).targets[0].id, 'pass'), inputTokens: 5 })]),
        budget: f.snapshot.contract.reviewSettings!.budget,
      },
    })
    expect(run.status).toBe('completed')
    const revised = revise(f.root, f.snapshot, { budget: { maxCallsPerRun: 20 } })
    const input = {
      root: f.root, adapter: fakeAdapter([]), contractHash: semanticContractHash(revised.contract),
      snapshot: revised, stages: ['claims' as ReviewStage], targetClaimIds: f.claims.map((c) => c.id),
    }
    // Same shape → every planned claims task still matches a completed record.
    const history = allRecords(f.root, f.snapshot.projectId)
    expect(planContinueTasks(input).every((t) =>
      history.some((r) => reusableCompleted(r, t.inputHash, new Set(t.task.requiredRules.map((x) => x.ruleId)))))).toBe(true)
    expect(continueHasWork(input)).toBe(false)
  })

  it('cross-shape reshape 1→2: completed batch-of-1 records no longer match, without erroring; delivery reports claims not-run', async () => {
    const f = claimsOnly(fixture(undefined, { budget: { ...BUDGET, maxCallsPerRun: 10, maxOutputTokensPerRun: 100_000 }, claimsBatchSize: 1 }))
    const run = await executeReviewRun({
      ...f.base,
      runId: `run_${randomUUID()}`, requestId: randomUUID(),
      deps: {
        root: f.root, contractHash: semanticContractHash(f.snapshot.contract),
        adapter: fakeAdapter([(req) => ({ raw: claimsResponse(JSON.parse(req.messages[1]!.content).targets[0].id, 'pass'), inputTokens: 5 })]),
        budget: f.snapshot.contract.reviewSettings!.budget,
      },
    })
    expect(run.status).toBe('completed')
    const revised = revise(f.root, f.snapshot, { claimsBatchSize: 2 })
    const input = {
      root: f.root, adapter: fakeAdapter([]), contractHash: semanticContractHash(revised.contract),
      snapshot: revised, stages: ['claims' as ReviewStage], targetClaimIds: f.claims.map((c) => c.id),
    }
    // The re-batched task (both claims in one batch) does not match any
    // stored record — reshape is reuse-shape-scoped, not an error.
    const reshaped = planContinueTasks(input)
    expect(reshaped).toHaveLength(1)
    expect(allRecords(f.root, f.snapshot.projectId).some((r) =>
      reusableCompleted(r, reshaped[0]!.inputHash, new Set(reshaped[0]!.task.requiredRules.map((x) => x.ruleId))))).toBe(false)
    expect(continueHasWork(input)).toBe(true)
    const index = buildReverseIndex(revised)
    const progress = computeStageProgress({
      snapshot: revised, index,
      core: frozenCoreSet({ root: f.root, index, snapshot: revised }),
      targets: f.claims.map((c) => c.id),
      records: allRecords(f.root, f.snapshot.projectId),
      claimsBatchSize: revised.contract.reviewSettings!.claimsBatchSize,
    })
    // Delivery/progress report the reshaped claims task as not-run.
    expect(progress.stageProgress.claims).toMatchObject({ total: 1, completed: 0, notRun: 1 })
  })
})

describe('upgrade disclosure: pre-upgrade records are invalidated once (§F3.2)', () => {
  it('a record whose contractHash was computed with the FULL contract does not reuse after revision', () => {
    const f = fixture()
    const adapter = fakeAdapter([])
    const configHash = sha256Hex(stableJson(adapter.configFingerprint()))
    const planInput = {
      root: f.root, adapter, contractHash: semanticContractHash(f.snapshot.contract),
      snapshot: f.snapshot, stages: ['claims' as ReviewStage],
      targetClaimIds: f.claims.map((c) => c.id), history: [] as ReviewRecord[],
    }
    const task0 = planContinueTasks(planInput).find((t) => t.task.targetRefs[0]!.id === f.claims[0]!.id)!
    const fullContractHash = sha256Hex(stableJson(f.snapshot.contract))
    // Simulate a PRE-UPGRADE record: its stored cache key was computed with
    // the full contract hash (including reviewSettings). §F3.2: no rewriting,
    // no probing — such records are invalidated ONCE at upgrade (money, not
    // correctness).
    const preKey = cacheKey({
      stage: 'claims', targetRefs: task0.task.targetRefs, requiredRules: task0.task.requiredRules,
      dependencyDigest: taskDependencyDigest(buildReverseIndex(f.snapshot), task0.task, []),
      contractHash: fullContractHash, policyHash: policyHash(), reviewerConfigHash: configHash,
      promptHash: promptHash('claims'),
    })
    const preUpgrade: ReviewRecord = {
      runId: 'run_legacy', stage: 'claims',
      targetRefs: task0.task.targetRefs, dependencyDigest: 'dep',
      contractHash: fullContractHash, policyHash: policyHash(), reviewerConfigHash: configHash,
      promptHash: promptHash('claims'), artifactHash: 'a', inputHash: preKey,
      status: 'completed', inputTokens: 5, outputTokens: 5,
      startedAt: NOW, endedAt: NOW,
      response: JSON.parse(claimsResponse(f.claims[0]!.id, 'pass')),
    }
    const required = new Set(task0.task.requiredRules.map((r) => r.ruleId))
    expect(reusableCompleted(preUpgrade, task0.inputHash, required)).toBe(false)
    // Records written AFTER the change (semantic hash) DO match — the
    // invalidation is one-time, not a permanent penalty.
    const postUpgrade = { ...preUpgrade, contractHash: semanticContractHash(f.snapshot.contract), inputHash: task0.inputHash }
    expect(reusableCompleted(postUpgrade, task0.inputHash, required)).toBe(true)
  })
})

/** A completed record matches the planned key and is reusable (§A.3.2). */
function reusableCompleted(record: ReviewRecord, key: string, required: ReadonlySet<string>): boolean {
  return recordMatchesKey(record, key) && record.kind !== 'disagreement' &&
    recordReusable(record, required)
}
