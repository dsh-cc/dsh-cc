/**
 * Pure-selector specs for the SystemOne memory recall selector (design
 * docs/plans/2026-11-02-systemone-03-memory-recall.md §"Candidate identity and
 * input contract", §"Complete batching and deterministic filtering").
 *
 * Only the pure parts are pinned here — candidate identity (stable per-pool
 * IDs), the deterministic probability filter with its whole-pool grey-zone
 * signal, the complete batch plan checked against the run's batch-count cap,
 * and the remaining-deadline degrade helper. Runner adaptation (requests,
 * reservations, re-identification) is a later slice and is NOT exercised here.
 */
import { describe, expect, it } from 'vitest'
import { MAX_RECALL_MEMORIES } from '../src/recall.ts'
import {
  MIN_RECALL_BATCH_REMAINING_MS,
  assignRecallTopicIds,
  planRecallBatches,
  recallBatchCountCap,
  selectIds,
  shouldDegradeForDeadline,
} from '../src/recall-decision.ts'
import type { RecallProbabilityRow, RecallScope, RecallTopicSeed } from '../src/recall-decision.ts'

/** One probability row (workspace scope unless stated). */
function row(id: string, probability: number, scope: RecallScope = 'workspace'): RecallProbabilityRow {
  return { id, probability, scope }
}

/** One scanned candidate seed as the host hands it over (no id yet). */
function seed(path: string, scope: RecallScope, filename = 'rules.md'): RecallTopicSeed {
  return {
    scope,
    path,
    filename,
    name: filename.replace(/\.md$/, ''),
    description: `${scope} candidate at ${path}`,
    contentHash: `hash:${scope}:${path}`,
  }
}

describe('assignRecallTopicIds', () => {
  it('gives two same-named rules.md files in different scopes distinct stable IDs, workspace first', () => {
    const topics = assignRecallTopicIds([seed('/repo/.dsh/memory/rules.md', 'workspace'), seed('/home/u/.dsh/memory/rules.md', 'global')])
    expect(topics.map(t => [t.id, t.scope])).toEqual([
      ['m0000', 'workspace'],
      ['m0001', 'global'],
    ])
    // Same name, distinct identity — the whole point of host-side IDs.
    expect(topics[0]?.filename).toBe('rules.md')
    expect(topics[1]?.filename).toBe('rules.md')
    expect(new Set(topics.map(t => t.id)).size).toBe(2)
  })

  it('is independent of input order: workspace-first, then UTF-8 byte order of the canonical path', () => {
    const seeds = [
      seed('/repo/zeta.md', 'workspace'),
      seed('/home/u/.dsh/memory/alpha.md', 'global'),
      seed('/repo/alpha.md', 'workspace'),
      // 'B' (0x42) sorts before 'a' (0x61) in UTF-8 byte order, not by locale.
      seed('/repo/Beta.md', 'workspace'),
      seed('/home/u/.dsh/memory/Zeta.md', 'global'),
    ]
    const forward = assignRecallTopicIds(seeds)
    const backward = assignRecallTopicIds([...seeds].reverse())
    const paths = forward.map(t => t.path)
    expect(paths).toEqual([
      '/repo/Beta.md',
      '/repo/alpha.md',
      '/repo/zeta.md',
      '/home/u/.dsh/memory/Zeta.md',
      '/home/u/.dsh/memory/alpha.md',
    ])
    expect(backward.map(t => [t.id, t.path])).toEqual(forward.map(t => [t.id, t.path]))
    expect(forward.map(t => t.id)).toEqual(['m0000', 'm0001', 'm0002', 'm0003', 'm0004'])
  })

  it('keeps the host-only fields (path, contentHash) on the assigned topic', () => {
    const [first] = assignRecallTopicIds([seed('/repo/.dsh/memory/vitest-flaky.md', 'workspace', 'vitest-flaky.md')])
    expect(first?.path).toBe('/repo/.dsh/memory/vitest-flaky.md')
    expect(first?.contentHash).toBe('hash:workspace:/repo/.dsh/memory/vitest-flaky.md')
  })
})

describe('selectIds', () => {
  it('selects the boundary items [0.25, 0.75, 0.91] without a fallback', () => {
    const ids = selectIds([row('m0000', 0.25), row('m0001', 0.75), row('m0002', 0.91)], 0.25, 0.75)
    // 0.75 is an explicit inclusion, 0.25 an explicit exclusion; no grey zone.
    expect(ids).toEqual(['m0002', 'm0001'])
  })

  it('signals a whole-pool fallback for [0.10, 0.50, 0.91] instead of adopting the high item', () => {
    expect(selectIds([row('m0000', 0.1), row('m0001', 0.5), row('m0002', 0.91)], 0.25, 0.75)).toBeUndefined()
  })

  it('treats the grey zone as the OPEN interval (excludeProbability, includeProbability)', () => {
    // Exactly at either boundary is not grey.
    expect(selectIds([row('m0000', 0.25), row('m0001', 0.75)], 0.25, 0.75)).toEqual(['m0001'])
    // Just inside it is.
    expect(selectIds([row('m0000', 0.2501)], 0.25, 0.75)).toBeUndefined()
    expect(selectIds([row('m0000', 0.7499)], 0.25, 0.75)).toBeUndefined()
  })

  it('returns an empty (not undefined) selection when every probability is low', () => {
    const ids = selectIds([row('m0000', 0.04), row('m0001', 0.1), row('m0002', 0.25)], 0.25, 0.75)
    expect(ids).toEqual([])
  })

  it('takes exactly MAX_RECALL_MEMORIES items ordered by probability, workspace first, then ID bytes', () => {
    const rows = [
      row('m0000', 0.95),
      row('m0001', 0.9),
      row('m0002', 0.9, 'global'),
      row('m0003', 0.8),
      row('m0004', 0.76),
      row('m0005', 0.95, 'global'),
      row('m0006', 0.99),
    ]
    const ids = selectIds(rows, 0.25, 0.75)
    expect(MAX_RECALL_MEMORIES).toBe(5)
    expect(ids).toEqual(['m0006', 'm0000', 'm0005', 'm0001', 'm0002'])
  })

  it('breaks exact probability ties by UTF-8 byte order of the ID', () => {
    const ids = selectIds([row('m0010', 0.9), row('m0009', 0.9)], 0.25, 0.75)
    expect(ids).toEqual(['m0009', 'm0010'])
  })

  it('selects nothing (empty, not undefined) from an empty pool', () => {
    expect(selectIds([], 0.25, 0.75)).toEqual([])
  })
})

describe('recallBatchCountCap', () => {
  it('is ceil(maxCandidates / batchSize)', () => {
    expect(recallBatchCountCap(96, 24)).toBe(4)
    expect(recallBatchCountCap(97, 24)).toBe(5)
    expect(recallBatchCountCap(1, 24)).toBe(1)
  })
})

describe('planRecallBatches', () => {
  const limits = { batchSize: 24, maxCandidates: 96, maxQuestions: 24 }
  const ids = (count: number): string[] => Array.from({ length: count }, (_, i) => `m${String(i).padStart(4, '0')}`)

  it('degrades before any dispatch when the pool exceeds maxCandidates (97 vs 96)', () => {
    const plan = planRecallBatches(ids(97), limits)
    expect(plan.kind).toBe('degraded')
    expect(plan).toMatchObject({ kind: 'degraded', reason: 'candidates-over-limit' })
  })

  it('splits 25 candidates at batchSize=24 into two batches covering every candidate exactly once', () => {
    const pool = ids(25)
    const plan = planRecallBatches(pool, limits)
    expect(plan.kind).toBe('planned')
    if (plan.kind !== 'planned') return
    expect(plan.batches.map(b => b.length)).toEqual([24, 1])
    expect(plan.batches.flat()).toEqual(pool)
    expect(plan.batches.flat().length).toBe(pool.length)
    // Cap is ceil(96 / 24) = 4 and the plan needs only 2.
    expect(plan.cap).toBe(4)
    expect(plan.batches.length).toBeLessThanOrEqual(plan.cap)
  })

  it('caps every batch at min(batchSize, route maxQuestions): 25 candidates with maxQuestions=12 plan 3 batches against a cap of 4', () => {
    const pool = ids(25)
    const plan = planRecallBatches(pool, { ...limits, maxQuestions: 12 })
    expect(plan.kind).toBe('planned')
    if (plan.kind !== 'planned') return
    expect(plan.batches.map(b => b.length)).toEqual([12, 12, 1])
    expect(plan.batches.length).toBe(3)
    expect(plan.cap).toBe(4)
    expect(plan.batches.flat()).toEqual(pool)
  })

  it('degrades the whole run when the planned batch count exceeds the cap (no partial batches)', () => {
    // maxQuestions=8 forces 12 batches for a 96 pool, over the cap of 4.
    const plan = planRecallBatches(ids(96), { ...limits, maxQuestions: 8 })
    expect(plan).toMatchObject({ kind: 'degraded', reason: 'batch-count-over-cap' })
  })

  it('plans exactly at the cap without degrading', () => {
    // 96 candidates at 24 per batch is precisely the cap of 4 batches.
    const plan = planRecallBatches(ids(96), limits)
    expect(plan.kind).toBe('planned')
    if (plan.kind !== 'planned') return
    expect(plan.batches.length).toBe(plan.cap)
    expect(plan.batches.map(b => b.length)).toEqual([24, 24, 24, 24])
  })

  it('degrades when the route advertises no per-question capacity', () => {
    expect(planRecallBatches(ids(5), { ...limits, maxQuestions: 0 })).toMatchObject({
      kind: 'degraded',
      reason: 'route-question-capacity',
    })
  })

  it('degrades on unusable limits instead of planning an empty or endless run', () => {
    expect(planRecallBatches(ids(5), { ...limits, batchSize: 0 })).toMatchObject({ kind: 'degraded', reason: 'invalid-limits' })
    expect(planRecallBatches(ids(5), { ...limits, maxCandidates: 0 })).toMatchObject({ kind: 'degraded', reason: 'invalid-limits' })
  })

  it('plans a single batch for an empty pool (nothing to dispatch is not a degrade)', () => {
    const plan = planRecallBatches([], limits)
    expect(plan.kind).toBe('planned')
    if (plan.kind !== 'planned') return
    expect(plan.batches).toEqual([])
  })
})

describe('shouldDegradeForDeadline', () => {
  it('degrades only when fewer than 100ms of the total deadline remain', () => {
    expect(MIN_RECALL_BATCH_REMAINING_MS).toBe(100)
    expect(shouldDegradeForDeadline(0)).toBe(true)
    expect(shouldDegradeForDeadline(99)).toBe(true)
    expect(shouldDegradeForDeadline(100)).toBe(false)
    expect(shouldDegradeForDeadline(1500)).toBe(false)
  })
})
