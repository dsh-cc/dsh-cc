/** Review-cycle accounting must survive tied clocks and overlapping requests. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cycleUsage } from '../src/review-cycle.ts'
import { ReviewRunStore } from '../src/review-run-store.ts'
import { executeReviewRun } from '../src/review-runner.ts'
import { BUDGET, claimsResponse, fakeAdapter, makeClaim, makeSnapshot } from './review-helpers.ts'

const workspace = () => mkdtempSync(join(tmpdir(), 'vwa-cycle-'))

describe('review-cycle budget regressions', () => {
  it('does not lose legacy continuation spend when timestamps tie and UUID order reverses admission order', () => {
    const root = workspace()
    const store = new ReviewRunStore(root, 'project')
    for (const [runId, continuation, calls] of [['run_z', false, 2], ['run_a', true, 1]] as const) {
      store.initRun(runId)
      store.writeRequest(runId, {
        schemaVersion: 1, requestId: runId, runId, stage: 'claims', targetClaimIds: [],
        continue: continuation, status: 'completed', calls, inputTokens: calls * 10, outputTokens: calls * 20,
        startedAt: '2026-10-19T00:00:00.000Z',
      })
    }
    expect(cycleUsage(root, 'project')).toEqual({ calls: 3, inputTokens: 30, outputTokens: 60 })
  })

  it.each([
    { maxCallsPerRun: 2 },
    { maxInputTokensPerRun: 20 },
    { maxOutputTokensPerRun: 40 },
  ])('atomically shares the remaining cycle budget across requestIds: %j', async (limit) => {
    const root = workspace()
    const claims = [makeClaim(), makeClaim(), makeClaim()]
    const snapshot = makeSnapshot({ claims })
    const budget = { ...BUDGET, maxOutputTokensPerCall: 20, ...limit }
    const run = (runId: string, index: number, continuation: boolean) => executeReviewRun({
      deps: {
        root, budget, contractHash: 'c'.repeat(64), now: () => index * 1000,
        adapter: { ...fakeAdapter([(req) => ({
          raw: claimsResponse(JSON.parse(req.messages[1]!.content).targets[0].id, 'pass'), inputTokens: 10, outputTokens: 20,
        })]), countInput: async () => ({ tokens: 10, method: 'tokenizer' as const }) },
      },
      snapshot, runId, requestId: runId, stages: ['claims'], targetClaimIds: [claims[index]!.id],
      continueMode: continuation, signal: new AbortController().signal,
    })
    expect((await run('run_fresh', 0, false)).calls).toBe(1)
    const results = await Promise.all([run('run_cont1', 1, true), run('run_cont2', 2, true)])
    expect(results.reduce((sum, result) => sum + result.calls, 0)).toBe(1)
    expect(results.map((result) => result.status).sort()).toEqual(['budget-exhausted', 'completed'])
    expect(cycleUsage(root, snapshot.projectId).calls).toBe(2)
  })

  it('keeps a queued continuation in its admitted cycle when a fresh run opens another cycle', async () => {
    const root = workspace()
    const claims = [makeClaim(), makeClaim(), makeClaim()]
    const snapshot = makeSnapshot({ claims })
    const store = new ReviewRunStore(root, snapshot.projectId)
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const ready = new Promise<void>((resolve) => { entered = resolve })
    const run = (runId: string, index: number, continuation: boolean, pause = false) => {
      const adapter = fakeAdapter([(req) => ({
        raw: claimsResponse(JSON.parse(req.messages[1]!.content).targets[0].id, 'pass'),
        inputTokens: 10, outputTokens: 20,
      })])
      adapter.countInput = async () => {
        if (pause) { entered(); await blocked }
        return { tokens: 10, method: 'tokenizer' }
      }
      return executeReviewRun({
        deps: { root, budget: { ...BUDGET, maxCallsPerRun: 2 }, contractHash: 'c'.repeat(64),
          now: () => 1000, adapter },
        snapshot, runId, requestId: runId, stages: ['claims'], targetClaimIds: [claims[index]!.id],
        continueMode: continuation, signal: new AbortController().signal,
      })
    }
    await run('run_z_first', 0, false)
    const continuation = run('run_a_continue', 1, true, true)
    await ready
    try {
      await run('run_b_new', 2, false)
    } finally { release() }
    expect((await continuation).status).toBe('completed')
    const first = store.readRequest('run_z_first') as { cycleId?: string } | undefined
    const continued = store.readRequest('run_a_continue') as { cycleId?: string } | undefined
    const newer = store.readRequest('run_b_new') as { cycleId?: string } | undefined
    expect(first?.cycleId).toBe('run_z_first')
    expect(continued?.cycleId).toBe(first?.cycleId)
    expect(newer?.cycleId).toBe('run_b_new')
    expect(cycleUsage(root, snapshot.projectId, 'run_a_continue').calls).toBe(1)
    expect(cycleUsage(root, snapshot.projectId).calls).toBe(1)
  })

})
