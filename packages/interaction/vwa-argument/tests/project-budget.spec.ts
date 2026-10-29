/**
 * Feature 4 §5.1 — project-cumulative budget: in-lock admission + per-call
 * reservation, the PROJECT_BUDGET_EXHAUSTED refusal, and the
 * applyReviewSettingsPatch round-trip that must not drop projectBudget.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { freezeReviewSettings } from '../src/review-config.ts'
import { applyReviewSettingsPatch } from '../src/review-settings-revision.ts'
import { projectUsage, reserveCycleCall, reserveCycleRequest } from '../src/review-cycle.ts'
import { ReviewRunStore } from '../src/review-run-store.ts'

const workspace = () => mkdtempSync(join(tmpdir(), 'vwa-project-budget-'))

function request(runId: string, startedAt: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const, requestId: runId, runId, stage: 'claims', targetClaimIds: [],
    status: 'queued' as const, calls: 0, inputTokens: 0, outputTokens: 0, startedAt, ...extra,
  }
}

describe('§5.1 project-cumulative budget', () => {
  it('projectUsage reconciles the durable ledger across every cycle', () => {
    const root = workspace(), projectId = 'project'
    const store = new ReviewRunStore(root, projectId)
    store.initRun('run_a')
    store.writeRequest('run_a', request('run_a', '2026-10-28T00:00:00.000Z', { calls: 1 }))
    // A crashed run's durable reserved row still counts (loadRequest reconciles it).
    store.appendUsage('run_a', {
      runId: 'run_a', taskId: 'task', seq: 1, kind: 'reserved', inputTokens: 10, outputTokens: 20, method: 'tokenizer',
    })
    store.initRun('run_b')
    store.writeRequest('run_b', request('run_b', '2026-10-28T00:01:00.000Z', { calls: 2, inputTokens: 7, outputTokens: 9 }))
    expect(projectUsage(root, projectId)).toEqual({ calls: 3, inputTokens: 17, outputTokens: 29 })
    expect(projectUsage(root, projectId, 'run_b')).toEqual({ calls: 1, inputTokens: 10, outputTokens: 20 })
  })

  it('refuses admission with PROJECT_BUDGET_EXHAUSTED (retryable=false) when usage+estimate exceeds the ceiling', () => {
    const root = workspace(), projectId = 'project'
    const store = new ReviewRunStore(root, projectId)
    store.initRun('run_spent')
    store.writeRequest('run_spent', request('run_spent', '2026-10-28T00:00:00.000Z', { calls: 2 }))
    const refused = reserveCycleRequest(root, projectId, 'run_next', request(
      'run_next', '2026-10-28T00:01:00.000Z',
      { projectBudget: { maxCalls: 3 }, projectEstimatedCalls: 2 },
    ))
    // `'ok' in x` is the Fail discriminant (a success record carries no `ok`).
    expect('ok' in refused).toBe(true)
    if (!('ok' in refused)) return
    expect(refused.code).toBe('PROJECT_BUDGET_EXHAUSTED')
    expect(refused.retryable).toBe(false)
    // The transport fields never persist on the request record.
    expect(store.readRequest('run_spent')?.projectBudget).toBeUndefined()
  })

  it('per-call projection blocks the second run once the first has spent the ceiling', () => {
    const root = workspace(), projectId = 'project'
    const store = new ReviewRunStore(root, projectId)
    store.initRun('run_a')
    store.writeRequest('run_a', request('run_a', '2026-10-28T00:00:00.000Z', { calls: 1 }))
    store.initRun('run_b')
    store.writeRequest('run_b', request('run_b', '2026-10-28T00:01:00.000Z'))
    const budget = freezeReviewSettings().budget
    const reserve = () => true
    // own spend (1) + 1 > 1.
    expect(reserveCycleCall(root, projectId, 'run_b', budget, 10, reserve, { budget: { maxCalls: 1 }, runId: 'run_b' }))
      .toBe(false)
    expect(reserveCycleCall(root, projectId, 'run_b', budget, 10, reserve, { budget: { maxCalls: 2 }, runId: 'run_b' }))
      .toBe(true)
  })

  it('two concurrent reservations cannot both pass the in-lock per-call check', () => {
    const root = workspace(), projectId = 'project'
    const store = new ReviewRunStore(root, projectId)
    for (const runId of ['run_a', 'run_b']) {
      store.initRun(runId)
      store.writeRequest(runId, request(runId, '2026-10-28T00:00:00.000Z'))
    }
    const budget = freezeReviewSettings().budget
    const spend = (runId: string) => () => {
      store.appendUsage(runId, {
        runId, taskId: 'task', seq: 1, kind: 'reserved', inputTokens: 10, outputTokens: 20, method: 'tokenizer',
      })
      return true
    }
    expect(reserveCycleCall(root, projectId, 'run_a', budget, 10, spend('run_a'), { budget: { maxCalls: 1 }, runId: 'run_a' }))
      .toBe(true)
    expect(reserveCycleCall(root, projectId, 'run_b', budget, 10, spend('run_b'), { budget: { maxCalls: 1 }, runId: 'run_b' }))
      .toBe(false)
    expect(projectUsage(root, projectId).calls).toBe(1)
  })

  it('applyReviewSettingsPatch round-trip preserves projectBudget (rebuilt-literal trap)', () => {
    const current = { ...freezeReviewSettings(), projectBudget: { maxCalls: 12 } }
    const first = applyReviewSettingsPatch(current, { claimsBatchSize: 2 })
    expect(first.settings.projectBudget).toEqual({ maxCalls: 12 })
    const second = applyReviewSettingsPatch(first.settings, { projectBudget: { maxOutputTokens: 500 } })
    expect(second.settings.projectBudget).toEqual({ maxCalls: 12, maxOutputTokens: 500 })
    const third = applyReviewSettingsPatch(second.settings, { maxArtifactChars: 2000 })
    expect(third.settings.projectBudget).toEqual({ maxCalls: 12, maxOutputTokens: 500 })
    expect(second.fieldsChanged.projectBudget?.new).toEqual({ maxCalls: 12, maxOutputTokens: 500 })
  })
})
