/**
 * Slice 2 — F3.3 `set-review-settings` mutation op and F3.4 cycle-budget
 * persistence (docs/plans/2026-10-21-vwa-review-settings-revision.md §F3.3/§F3.4).
 * @module tests/review-settings-revision
 */
import { describe, expect, it } from 'vitest'
import { applyMutation, GraphContext } from '../src/graph.ts'
import { VwaFail, fail } from '../src/store.ts'
import { semanticContractHash } from '../src/review-contract.ts'
import { freezeReviewSettings } from '../src/review-config.ts'
import {
  afterRevisionCommit, discloseCycleBudgetStatus,
} from '../src/review-settings-revision.ts'
import {
  readCycleBudget, reserveCycleCall, reserveCycleRequest, updateLatestCycleBudget,
} from '../src/review-cycle.ts'
import { ReviewRunStore } from '../src/review-run-store.ts'
import { initWorkspace, uuid } from './helpers.ts'
import type { ProjectSnapshot } from '../src/types.ts'

function failOf(run: () => unknown): { code: string; message: string } {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof VwaFail) return { code: error.fail.code, message: error.fail.message }
    throw error
  }
  throw new Error('expected a VwaFail')
}

/** A snapshot with real frozen settings (identical to what store.init freezes). */
function graphWithSettings(settings = freezeReviewSettings()): GraphContext {
  const snapshot: ProjectSnapshot = {
    schemaVersion: 1, projectId: 'prj_x', revision: 3, workspaceIdentity: 'b'.repeat(64),
    contract: {
      question: 'q?', language: 'en', domain: 'history', requiredQuestions: [],
      plannedCorpus: [], expectedCoreTopics: [], mode: 'draft', reviewSettings: settings,
    },
    sources: [], evidence: [], claims: [], groups: [], arguments: [], issues: [], searches: [], artifacts: [],
  }
  return new GraphContext(structuredClone(snapshot), 10_000)
}

describe('F3.3 set-review-settings refusals', () => {
  it('rejects maxContextChars with the semantic-field reason', () => {
    const graph = graphWithSettings()
    const failure = failOf(() => applyMutation(graph, {
      op: 'set-review-settings', reviewSettings: { maxContextChars: 99_000 } as never,
    }))
    expect(failure.code).toBe('SCHEMA_INVALID')
    expect(failure.message).toContain('maxContextChars')
    expect(failure.message).toContain('identity')
  })

  it.each([
    { budget: { maxCallsPerRun: 0 } },
    { budget: { maxCallsPerRun: 201 } },
    { budget: { maxInputTokensPerRun: 999 } },
    { budget: { callTimeoutMs: 100 } },
    { budget: { concurrency: 5 } },
    { claimsBatchSize: 5 },
    { maxArtifactChars: 999 },
  ])('rejects out-of-range values with schema ranges: %j', (patch) => {
    const graph = graphWithSettings()
    const failure = failOf(() => applyMutation(graph, { op: 'set-review-settings', reviewSettings: patch }))
    expect(failure.code).toBe('SCHEMA_INVALID')
    expect(failure.message).toContain('FrozenReviewSettings schema violation')
  })

  it('rejects unknown top-level fields in the patch (no silent merge)', () => {
    const graph = graphWithSettings()
    const failure = failOf(() => applyMutation(graph, {
      op: 'set-review-settings', reviewSettings: { bogus: 1 } as never,
    }))
    expect(failure.code).toBe('SCHEMA_INVALID')
    expect(failure.message).toContain('unknown set-review-settings field: bogus')
  })

  it('rejects unknown budget fields in the patch', () => {
    const graph = graphWithSettings()
    const failure = failOf(() => applyMutation(graph, {
      op: 'set-review-settings', reviewSettings: { budget: { notAField: 1 } as never },
    }))
    expect(failure.message).toContain('unknown ReviewBudget field: notAField')
  })

  it('rejects a set-contract payload carrying reviewSettings (pointing at the new op)', () => {
    const graph = graphWithSettings()
    const failure = failOf(() => applyMutation(graph, {
      op: 'set-contract',
      contract: { ...graph.snapshot.contract, reviewSettings: freezeReviewSettings() },
    }))
    expect(failure.code).toBe('SCHEMA_INVALID')
    expect(failure.message).toContain('set-review-settings')
  })

  it('rejects the op on a project without frozen settings', () => {
    const graph = graphWithSettings()
    delete (graph.snapshot.contract as { reviewSettings?: unknown }).reviewSettings
    expect(failOf(() => applyMutation(graph, {
      op: 'set-review-settings', reviewSettings: { claimsBatchSize: 2 },
    })).message).toContain('no frozen review settings')
  })
})

describe('F3.3 successful revision', () => {
  it('merges only provided keys, reports fieldsChanged with old/new, keeps contractChanged false', () => {
    const before = freezeReviewSettings()
    const graph = graphWithSettings(structuredClone(before))
    const outcome = applyMutation(graph, {
      op: 'set-review-settings',
      reviewSettings: { budget: { maxCallsPerRun: 5, wallMs: 30_000 }, maxArtifactChars: 240_000 },
    })
    expect(outcome.contractChanged).toBe(false)
    expect(outcome.fieldsChanged).toEqual({
      'budget.maxCallsPerRun': { old: before.budget.maxCallsPerRun, new: 5 },
      'budget.wallMs': { old: before.budget.wallMs, new: 30_000 },
      maxArtifactChars: { old: before.maxArtifactChars, new: 240_000 },
    })
    expect(outcome.reuseStatement).toContain('preserved')
    expect(outcome.reuseStatement).toContain('claims not-run')
    // No default materialization: untouched keys keep their exact frozen values.
    const revised = graph.snapshot.contract.reviewSettings!
    expect(revised.maxContextChars).toBe(before.maxContextChars)
    expect(revised.claimsBatchSize).toBe(before.claimsBatchSize)
    expect(revised.budget).toEqual({ ...before.budget, maxCallsPerRun: 5, wallMs: 30_000 })
  })

  it('a budget-only revision keeps the semantic contract hash (reuse preserved)', () => {
    const before = graphWithSettings()
    const hashBefore = semanticContractHash(before.snapshot.contract)
    applyMutation(before, { op: 'set-review-settings', reviewSettings: { budget: { maxCallsPerRun: 9 } } })
    expect(semanticContractHash(before.snapshot.contract)).toBe(hashBefore)
  })

  it('bumps the head revision through the store and refuses a stale expectedRevision', () => {
    const made = initWorkspace()
    const head = made.store.readHead()
    if (!head.ok) throw new Error(head.message)
    const committed = made.store.withTransaction<{ fieldsChanged?: Record<string, { old: number; new: number }> }>({
      expectedRevision: head.data.head.revision,
      requestId: uuid(),
      payloadHash: uuid(),
      applyFn: (snapshot) => {
        const graph = new GraphContext(snapshot, 10_000)
        const outcome = applyMutation(graph, {
          op: 'set-review-settings', reviewSettings: { budget: { maxCallsPerRun: 7 } },
        })
        return { result: outcome }
      },
    })
    expect(committed.ok).toBe(true)
    if (!committed.ok) return
    expect(committed.revision).toBe(head.data.head.revision + 1)
    expect(committed.data.fieldsChanged?.['budget.maxCallsPerRun']?.new).toBe(7)
    // Stale expectedRevision: REVISION_CONFLICT, inherited from the CAS machinery.
    const stale = made.store.withTransaction({
      expectedRevision: head.data.head.revision,
      requestId: uuid(),
      payloadHash: uuid(),
      applyFn: (snapshot) => {
        applyMutation(new GraphContext(snapshot, 10_000), {
          op: 'set-review-settings', reviewSettings: { claimsBatchSize: 2 },
        })
        return { result: null }
      },
    })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.code).toBe('REVISION_CONFLICT')
  })
})

describe('F3.4 cycle budget persistence', () => {
  it('freezes the budget on the cycle lead request and uses it for reservations', () => {
    const root = initWorkspace().root, projectId = 'prj_cycle'
    const budget = { ...freezeReviewSettings().budget, maxCallsPerRun: 3, maxOutputTokensPerCall: 20 }
    const reserved = reserveCycleRequest(root, projectId, 'run_lead', {
      schemaVersion: 1, requestId: 'r1', runId: 'run_lead', stage: 'claims', targetClaimIds: [],
      status: 'running', calls: 0, inputTokens: 0, outputTokens: 0, budget,
      startedAt: '2026-10-21T00:00:00.000Z',
    })
    expect('ok' in reserved).toBe(false)
    if ('ok' in reserved) return
    // The cycle budget persists in the sidecar, not on the request record (P2 fix).
    expect(readCycleBudget(root, projectId, 'run_lead')).toEqual(budget)
    // The persisted cycle budget governs: the caller passes a DIFFERENT (tighter) budget.
    const tighter = { ...budget, maxCallsPerRun: 1 }
    const store = new ReviewRunStore(root, projectId)
    // A real reserve persists the usage row so the next check sees the spend.
    const reserve = () => {
      const r = store.readRequest('run_lead')!
      store.writeRequest('run_lead', {
        ...r, calls: r.calls + 1, inputTokens: r.inputTokens + 10, outputTokens: r.outputTokens + 20,
      })
      return true
    }
    expect(reserveCycleCall(root, projectId, 'run_lead', tighter, 10, reserve)).toBe(true)
    expect(reserveCycleCall(root, projectId, 'run_lead', tighter, 10, reserve)).toBe(true)
    // Call 3 fits the persisted cycle budget (max 3) though the caller's budget allows only 1.
    expect(reserveCycleCall(root, projectId, 'run_lead', tighter, 10, reserve)).toBe(true)
    // Call 4 exceeds the persisted cycle budget.
    expect(reserveCycleCall(root, projectId, 'run_lead', tighter, 10, reserve)).toBe(false)
  })

  it('updateLatestCycleBudget revises the LATEST cycle; legacy cycles are reported unrewritten', () => {
    const made = initWorkspace(), root = made.root, projectId = 'prj_cycle2'
    const budget = { ...freezeReviewSettings().budget, maxCallsPerRun: 2, maxOutputTokensPerCall: 20 }
    reserveCycleRequest(root, projectId, 'run_c1', {
      schemaVersion: 1, requestId: 'r1', runId: 'run_c1', stage: 'claims', targetClaimIds: [],
      status: 'running', calls: 0, inputTokens: 0, outputTokens: 0, budget,
      startedAt: '2026-10-21T00:00:00.000Z',
    })
    const revised = { ...budget, maxCallsPerRun: 5 }
    expect(updateLatestCycleBudget(root, projectId, revised)).toBe(true)
    const store = new ReviewRunStore(root, projectId)
    expect(readCycleBudget(root, projectId, 'run_c1')).toEqual(revised)
    // Future admissions in the same cycle now reserve against the revised ceiling.
    expect(reserveCycleCall(root, projectId, 'run_c1', budget, 10, () => true)).toBe(true)
    // No cycle at all → nothing to rewrite.
    expect(updateLatestCycleBudget(made.root, 'prj_empty', revised)).toBe(false)
  })

  it('a fresh cycle freezes the revised budget; a legacy lead (no budget) falls back to the caller budget', () => {
    const made = initWorkspace(), root = made.root, projectId = 'prj_cycle3'
    const budget = { ...freezeReviewSettings().budget, maxCallsPerRun: 2, maxOutputTokensPerCall: 20 }
    reserveCycleRequest(root, projectId, 'run_new', {
      schemaVersion: 1, requestId: 'r1', runId: 'run_new', stage: 'claims', targetClaimIds: [],
      status: 'running', calls: 0, inputTokens: 0, outputTokens: 0, budget: { ...budget, maxCallsPerRun: 4 },
      startedAt: '2026-10-21T00:00:00.000Z',
    })
    expect(readCycleBudget(root, projectId, 'run_new')?.maxCallsPerRun).toBe(4)
    // Legacy: a lead record with no persisted budget keeps the caller's budget (pre-F3.4 behavior).
    reserveCycleRequest(root, projectId, 'run_legacy_lead', {
      schemaVersion: 1, requestId: 'r2', runId: 'run_legacy_lead', stage: 'claims', targetClaimIds: [],
      status: 'running', calls: 0, inputTokens: 0, outputTokens: 0,
      startedAt: '2026-10-21T00:00:00.000Z',
    })
    expect(readCycleBudget(root, projectId, 'run_legacy_lead')).toBeUndefined()
    // Legacy: no persisted budget → the CALLER's budget (pre-F3.4 behavior) governs.
    const legacyStore = new ReviewRunStore(root, projectId)
    const reserve = () => {
      const r = legacyStore.readRequest('run_legacy_lead')!
      legacyStore.writeRequest('run_legacy_lead', { ...r, calls: r.calls + 1 })
      return true
    }
    expect(reserveCycleCall(root, projectId, 'run_legacy_lead', { ...budget, maxCallsPerRun: 1 }, 10, reserve)).toBe(true)
    expect(reserveCycleCall(root, projectId, 'run_legacy_lead', { ...budget, maxCallsPerRun: 1 }, 10, reserve)).toBe(false)
  })
})

describe('cycle-budget review fixes (P1/P2/P3)', () => {
  const base = freezeReviewSettings().budget

  function leadRequest(budget: typeof base): Parameters<typeof reserveCycleRequest>[3] {
    return {
      schemaVersion: 1, requestId: 'r1', runId: 'run_lead', stage: 'claims', targetClaimIds: [],
      status: 'running', calls: 0, inputTokens: 0, outputTokens: 0, budget,
      startedAt: '2026-10-21T00:00:00.000Z',
    }
  }

  it('P1: the output headroom check uses the calling run\'s actual per-call reservation, not the revised cycle per-call', () => {
    const made = initWorkspace(), root = made.root, projectId = 'prj_p1'
    const admitted = { ...base, maxOutputTokensPerRun: 10_000, maxOutputTokensPerCall: 3_000 }
    reserveCycleRequest(root, projectId, 'run_lead', leadRequest(admitted))
    const store = new ReviewRunStore(root, projectId)
    const lead = store.readRequest('run_lead')!
    store.writeRequest('run_lead', { ...lead, calls: 3, outputTokens: 8_500 })
    // Downward revision: the cycle keeps its 10,000 ceiling but the per-call cap drops to 1,000.
    expect(updateLatestCycleBudget(root, projectId, { ...admitted, maxOutputTokensPerCall: 1_000 })).toBe(true)
    // An in-flight run still RESERVES with its locally frozen per-call cap of 3,000
    // (8,500 + 3,000 > 10,000) — the check must use the actual reservation, so this refuses.
    expect(reserveCycleCall(root, projectId, 'run_lead', admitted, 10, () => true)).toBe(false)
  })

  it('P2: a running task\'s request write-back cannot overwrite the revised cycle budget', () => {
    const made = initWorkspace(), root = made.root, projectId = 'prj_p2'
    const admitted = { ...base, maxCallsPerRun: 2, maxOutputTokensPerCall: 20 }
    reserveCycleRequest(root, projectId, 'run_lead', leadRequest(admitted))
    const store = new ReviewRunStore(root, projectId)
    // The runner's start-of-run in-memory snapshot of its own request record.
    const inMemory = store.readRequest('run_lead')!
    expect(updateLatestCycleBudget(root, projectId, { ...admitted, maxCallsPerRun: 9 })).toBe(true)
    // The in-flight runner writes its usage back from the stale in-memory copy.
    store.writeRequest('run_lead', { ...inMemory, calls: 1, inputTokens: 10, outputTokens: 20 })
    // The cycle ceiling is still the revised 9 (calls 1→2→3 fit); a reverted
    // ceiling of 2 would refuse the third call.
    const reserve = () => {
      const r = store.readRequest('run_lead')!
      store.writeRequest('run_lead', { ...r, calls: r.calls + 1 })
      return true
    }
    expect(reserveCycleCall(root, projectId, 'run_lead', { ...admitted, maxCallsPerRun: 9 }, 10, reserve)).toBe(true)
    expect(reserveCycleCall(root, projectId, 'run_lead', { ...admitted, maxCallsPerRun: 9 }, 10, reserve)).toBe(true)
  })

  it('P3: a failed cycle-budget rewrite is surfaced to the revision result, not silently swallowed', () => {
    const made = initWorkspace()
    const okResult = {
      ok: true as const, projectId: 'prj_p3', revision: 2,
      data: { reviewSettings: freezeReviewSettings(), fieldsChanged: {}, reuseStatement: '', contractChanged: false },
    }
    // No cycle exists for this project → the cycle-budget rewrite fails and the
    // caller learns about it (previously: void, silently ignored).
    expect(afterRevisionCommit(made.root, 'prj_p3', 'set-review-settings', okResult)).toBe(false)
    // A successful rewrite reports true.
    const projectId = 'prj_p3b'
    reserveCycleRequest(made.root, projectId, 'run_lead', leadRequest(base))
    expect(afterRevisionCommit(made.root, projectId, 'set-review-settings', okResult)).toBe(true)
    // Non-revision ops report undefined (nothing to sync).
    expect(afterRevisionCommit(made.root, projectId, 'upsert', okResult)).toBe(undefined)
    // The disclosure helper annotates an otherwise-successful revision result.
    const annotated = discloseCycleBudgetStatus(okResult, false)
    if (annotated.ok) {
      const data = annotated.data as { cycleBudgetUpdated?: boolean; cycleBudgetNote?: string }
      expect(data.cycleBudgetUpdated).toBe(false)
      expect(data.cycleBudgetNote).toContain('current review cycle')
    } else throw new Error('expected an ok result')
  })
})

