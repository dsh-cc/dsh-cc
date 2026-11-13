/**
 * The capacity contract of
 * `docs/plans/2026-11-13-skill-recommender-capacity.md` (C1–C4): token-packed
 * batches under a two-dimension emit invariant, route-aware caps, deadline
 * partial coverage with its abort-normalization and precedence rules, and the
 * never-cached partial.
 *
 * Each test names the design section it pins. The pure layer is exercised
 * exactly as `recommend.spec.ts` does — fake runner, fake catalog, no I/O —
 * plus direct `planBatches` calls for the planner's own arithmetic.
 *
 * @module @dsh-cc/skill-recommender/tests/capacity
 */

import { describe, expect, it } from 'vitest'
import { estimateDecisionInputTokens } from '@dsh-cc/systemone'
import { planBatches } from '../src/pool.ts'
import type { RecommendationBatch, RecommendationLimits, SkillPoolItem } from '../src/pool.ts'
import { recommendSkills } from '../src/recommend.ts'
import type { RecommendationOutcome } from '../src/recommend.ts'
import { parseRecommendationSettings, DEFAULT_RECOMMENDATION_SETTINGS } from '../src/settings.ts'
import { RecommendationCache } from '../src/cache.ts'
import type {
  SkillDecisionRequest,
  SkillDecisionRun,
  SkillDescriptor,
  SkillRecommendationRunner,
  SkillRecommendationScope,
} from '../src/types.ts'

const SCOPE: SkillRecommendationScope = { projectKey: 'proj', sessionId: 'sess', agentId: 'agent', originSeq: 3 }
const ROUTE_ALIAS = 'systemone-decision'
const TASK = 'write interface tests for the existing controller'

function withLimits(overrides: Partial<RecommendationLimits> = {}): RecommendationLimits {
  return {
    timeoutMs: 5000,
    maxInputTokens: 4096,
    maxCandidates: 64,
    batchSize: 8,
    maxTaskChars: 2048,
    maxMetadataChars: 2048,
    minRelevanceIndex: 3,
    minPrerequisitesMet: 0.8,
    maxRecommendations: 3,
    minCoverage: 1,
    ...overrides,
  }
}

function skill(name: string, overrides: Partial<SkillDescriptor> = {}): SkillDescriptor {
  return {
    name,
    description: `${name} capability.`,
    source: 'plugin',
    modelInvocable: true,
    ...overrides,
  }
}

/** A pool item exactly as `buildEligiblePool` would mint it. */
function item(index: number, name: string, metadata = `${name} capability.`): SkillPoolItem {
  return { id: `s${index}`, name, description: metadata, source: 'plugin' }
}

/** The fake runner seam: records requests, answers from a handler. */
function recording(handler: (request: SkillDecisionRequest, index: number) => SkillDecisionRun): {
  runner: SkillRecommendationRunner
  calls: SkillDecisionRequest[]
} {
  const calls: SkillDecisionRequest[] = []
  const runner: SkillRecommendationRunner = {
    identifyRoute: () => undefined,
    scope: () => SCOPE,
    run: async request => {
      const index = calls.length
      calls.push(request)
      await Promise.resolve()
      return handler(request, index)
    },
  }
  return { runner, calls }
}

function answerAll(request: SkillDecisionRequest, relevance = 3.5, prerequisites = 0.9): SkillDecisionRun {
  const answers: Record<string, { type: 'score'; score: number } | { type: 'noul'; noul: number }> = {}
  for (const entry of (request.state as { skills: ReadonlyArray<{ id: string }> }).skills) {
    answers[`${entry.id}_relevance`] = { type: 'score', score: relevance }
    answers[`${entry.id}_prerequisites`] = { type: 'noul', noul: prerequisites }
  }
  return { status: 'answered', answers, decisionId: `decision-${decisionCounter++}` }
}

/** Decision-id counter shared by the answering handlers. */
let decisionCounter = 0

async function recommend(
  candidates: readonly SkillDescriptor[],
  runner: SkillRecommendationRunner | undefined,
  limits: RecommendationLimits = withLimits(),
  routeCaps?: { perRequestTokens: number; perQuestionTokens: number; maxQuestions: number },
  signal: AbortSignal = new AbortController().signal,
): Promise<RecommendationOutcome> {
  return recommendSkills({
    task: TASK,
    scope: SCOPE,
    signal,
    mode: 'active',
    candidates,
    limits,
    routeAlias: ROUTE_ALIAS,
    ...routeCaps === undefined ? {} : { routeCaps },
  }, runner)
}

/** One batch's gateway-arithmetic estimate, exactly as the runner computes it. */
function estimateOf(batch: RecommendationBatch): { requestTokens: number; questionTokens: Record<string, number> } {
  return estimateDecisionInputTokens(batch.state, batch.questions)
}

describe('C1 token-packed batches', () => {
  it('cuts before the item that would exceed the token cap and keeps every emitted batch within it', () => {
    // Metadata sized so ~2 items fit 900 tokens but 3 do not; batch cap 16.
    const metadata = 'x'.repeat(600)
    const items = [item(0, 'alpha', metadata), item(1, 'beta', metadata), item(2, 'gamma', metadata), item(3, 'delta', metadata)]
    const plan = planBatches(items, TASK, withLimits({ maxInputTokens: 900 }), 'sha256:x')

    expect(plan.kind).toBe('batches')
    if (plan.kind !== 'batches') return
    expect(plan.batches.length).toBeGreaterThan(1)
    for (const batch of plan.batches) {
      expect(estimateOf(batch).requestTokens).toBeLessThanOrEqual(900)
      expect(batch.items.length).toBeLessThanOrEqual(16)
    }
    // No item lost, no reordering.
    expect(plan.batches.flatMap(batch => batch.items.map(i => i.name))).toEqual(['alpha', 'beta', 'gamma', 'delta'])
  })

  it('restarts the singleton after a cut and refuses a single item over the cap', () => {
    // Item 0 fits alone; the pair does not fit; item 1 alone does not fit either.
    const big = 'y'.repeat(3000)
    const items = [item(0, 'small', 'tiny.'), item(1, 'oversized', big)]
    const plan = planBatches(items, TASK, withLimits({ maxInputTokens: 500 }), 'sha256:x')

    expect(plan).toEqual({ kind: 'unavailable', reason: 'input-tokens' })
  })

  it('emits a valid final batch when the last item starts a new batch', () => {
    const metadata = 'z'.repeat(400)
    const items = [item(0, 'alpha', metadata), item(1, 'beta', metadata), item(2, 'gamma', metadata)]
    const plan = planBatches(items, TASK, withLimits({ maxInputTokens: 700 }), 'sha256:x')

    expect(plan.kind).toBe('batches')
    if (plan.kind !== 'batches') return
    const last = plan.batches[plan.batches.length - 1]
    expect(estimateOf(last).requestTokens).toBeLessThanOrEqual(700)
  })

  it('keeps the old clamp: a batch size below 1 becomes 1', () => {
    const items = [item(0, 'alpha'), item(1, 'beta')]
    const plan = planBatches(items, TASK, withLimits({ batchSize: 0 }), 'sha256:x')

    expect(plan.kind).toBe('batches')
    if (plan.kind !== 'batches') return
    for (const batch of plan.batches) expect(batch.items.length).toBe(1)
  })

  it('cuts on the per-question cap even when the request estimate fits (the estimator bills the whole state per question)', () => {
    const metadata = 'q'.repeat(600)
    const items = [item(0, 'alpha', metadata), item(1, 'beta', metadata)]
    // Request cap high, question cap low: the pair's request fits but each
    // question (state included) exceeds the question cap.
    const plan = planBatches(items, TASK, withLimits({ maxInputTokens: 4000 }), 'sha256:x', 400)

    expect(plan.kind).toBe('batches')
    if (plan.kind !== 'batches') return
    for (const batch of plan.batches) {
      const estimate = estimateOf(batch)
      for (const id of Object.keys(batch.questions)) {
        expect(estimate.questionTokens[id] ?? 0).toBeLessThanOrEqual(400)
      }
    }
  })

  it('refuses a single item that cannot fit the question cap', () => {
    const items = [item(0, 'huge', 'w'.repeat(1200))]
    const plan = planBatches(items, TASK, withLimits({ maxInputTokens: 8000 }), 'sha256:x', 300)

    expect(plan).toEqual({ kind: 'unavailable', reason: 'input-tokens' })
  })

  it('reproduces the old fixed slicing when every slice fits under the new estimator (equivalence oracle)', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n, i) => item(i, `skill-${n}`))
    const limits = withLimits({ batchSize: 3 })
    const plan = planBatches(items, TASK, limits, 'sha256:x')
    expect(plan.kind).toBe('batches')
    if (plan.kind !== 'batches') return

    // The OLD algorithm, re-implemented inline as the oracle: fixed slices of
    // batchSize validated with the NEW estimator.
    const size = Math.max(1, Math.floor(limits.batchSize))
    const oracle: RecommendationBatch[] = []
    for (let start = 0; start < items.length; start += size) {
      const slice = items.slice(start, start + size)
      const questions: Record<string, { type: 'score' | 'noul'; instructions: string; criteria?: string[] }> = {}
      for (const s of slice) {
        questions[`${s.id}_relevance`] = { type: 'score', instructions: 'r', criteria: [] }
        questions[`${s.id}_prerequisites`] = { type: 'noul', instructions: 'p' }
      }
      oracle.push({ items: slice, questions, state: { task: TASK, skills: slice, catalogHash: 'sha256:x' } })
    }
    expect(plan.batches.length).toBe(oracle.length)
    for (let index = 0; index < oracle.length; index += 1) {
      expect(plan.batches[index].items).toEqual(oracle[index].items)
      expect(plan.batches[index].state).toEqual(oracle[index].state)
      expect(Object.keys(plan.batches[index].questions)).toEqual(Object.keys(oracle[index].questions))
    }
  })
})

describe('C2 route caps', () => {
  it('refuses with route-cap before planning when the route cannot carry two questions', async () => {
    const { runner, calls } = recording(answerAll)
    const outcome = await recommend([skill('alpha')], runner, withLimits(), { perRequestTokens: 100000, perQuestionTokens: 100000, maxQuestions: 1 })

    expect(outcome).toEqual({ kind: 'unavailable', reason: 'route-cap' })
    expect(calls).toHaveLength(0)
  })

  it('folds perRequestTokens into the effective token cap and sends it on the wire', async () => {
    const { runner, calls } = recording(answerAll)
    const outcome = await recommend([skill('alpha')], runner, withLimits({ maxInputTokens: 4096 }), { perRequestTokens: 1200, perQuestionTokens: 100000, maxQuestions: 64 })

    expect(outcome.kind).toBe('recommended')
    expect(calls[0]?.maxInputTokens).toBe(1200)
  })

  it('folds floor(maxQuestions / 2) into the effective batch cap', async () => {
    // 5 skills, settings batch cap 8, route maxQuestions 6 → at most 3 skills per batch.
    const { runner, calls } = recording(answerAll)
    const outcome = await recommend(
      ['a', 'b', 'c', 'd', 'e'].map(n => skill(n)),
      runner,
      withLimits({ batchSize: 8 }),
      { perRequestTokens: 100000, perQuestionTokens: 100000, maxQuestions: 6 },
    )

    expect(outcome.kind).toBe('recommended')
    expect(calls.length).toBe(2)
    for (const call of calls) {
      expect((call.state as { skills: unknown[] }).skills.length).toBeLessThanOrEqual(3)
    }
  })

  it('does not change the wire field when no route caps are supplied', async () => {
    const { runner, calls } = recording(answerAll)
    await recommend([skill('alpha')], runner, withLimits({ maxInputTokens: 2048 }))

    expect(calls[0]?.maxInputTokens).toBe(2048)
  })
})

describe('C3 deadline partial coverage', () => {
  function catalog(count: number): SkillDescriptor[] {
    return Array.from({ length: count }, (_, i) => skill(`skill-${i}`))
  }

  it('publishes a partial when a runner timeout hits mid-plan and coverage clears the floor', async () => {
    // 6 skills, batch size 3 → 2 batches; batch 1 times out.
    const { runner } = recording((request, index) =>
      index === 0 ? answerAll(request) : { status: 'unavailable', reason: 'timeout', decisionId: 'd1' })
    const outcome = await recommend(catalog(6), runner, withLimits({ batchSize: 3, minCoverage: 0.5 }))

    expect(outcome).toEqual({
      kind: 'recommended',
      recommendations: expect.any(Array),
      decisionIds: [expect.any(String)],
      judged: 3,
      eligible: 6,
    })
  })

  it('discards everything when coverage is below the floor', async () => {
    const { runner } = recording((request, index) =>
      index === 0 ? answerAll(request) : { status: 'unavailable', reason: 'timeout' })
    const outcome = await recommend(catalog(9), runner, withLimits({ batchSize: 3, minCoverage: 0.5 }))

    expect(outcome).toEqual({ kind: 'unavailable', reason: 'timeout' })
  })

  it('discards everything when nothing was answered, even at floor 0', async () => {
    const { runner } = recording(() => ({ status: 'unavailable', reason: 'timeout' }))
    const outcome = await recommend(catalog(3), runner, withLimits({ minCoverage: 0 }))

    expect(outcome).toEqual({ kind: 'unavailable', reason: 'timeout' })
  })

  it('keeps min-coverage 1 byte-identical with the old completeness rule', async () => {
    const { runner } = recording((request, index) =>
      index === 0 ? answerAll(request) : { status: 'unavailable', reason: 'timeout' })
    const outcome = await recommend(catalog(6), runner, withLimits({ batchSize: 3, minCoverage: 1 }))

    expect(outcome).toEqual({ kind: 'unavailable', reason: 'timeout' })
  })

  it('publishes a partial when the runner reports cancelled with the deadline signal fired', async () => {
    // A real deadline (tiny timeoutMs) aborts the in-flight batch; the fake
    // runner mimics SystemOne by reporting that abort as `cancelled`.
    const { runner } = recording(async (request, index) => {
      if (index === 0) return answerAll(request)
      await new Promise(resolve => setTimeout(resolve, 60))
      return { status: 'unavailable', reason: 'cancelled' }
    })
    const outcome = await recommend(catalog(6), runner, withLimits({ batchSize: 3, timeoutMs: 40, minCoverage: 0.5 }))

    expect(outcome).toEqual({
      kind: 'recommended',
      recommendations: expect.any(Array),
      decisionIds: [expect.any(String)],
      judged: 3,
      eligible: 6,
    })
  })

  it('classifies an abort-class throw with the deadline fired as deadline exhaustion', async () => {
    const abortError = new DOMException('aborted', 'AbortError')
    const { runner } = recording(async (request, index) => {
      if (index === 0) return answerAll(request)
      await new Promise(resolve => setTimeout(resolve, 60))
      throw abortError
    })
    const outcome = await recommend(catalog(6), runner, withLimits({ batchSize: 3, timeoutMs: 40, minCoverage: 0.5 }))

    expect(outcome).toEqual({
      kind: 'recommended',
      recommendations: expect.any(Array),
      decisionIds: [expect.any(String)],
      judged: 3,
      eligible: 6,
    })
  })

  it('keeps a non-abort lane error coinciding with the deadline as an error, not partial', async () => {
    const { runner } = recording(async (request, index) => {
      if (index === 0) return answerAll(request)
      await new Promise(resolve => setTimeout(resolve, 60))
      throw new Error('gateway 503')
    })
    const outcome = await recommend(catalog(6), runner, withLimits({ batchSize: 3, timeoutMs: 40, minCoverage: 0 }))

    expect(outcome).toEqual({ kind: 'unavailable', reason: 'error' })
  })

  it('keeps a lane-side cancelled without the deadline as cancelled, not partial', async () => {
    const { runner } = recording((request, index) =>
      index === 0 ? answerAll(request) : { status: 'unavailable', reason: 'cancelled' })
    const outcome = await recommend(catalog(6), runner, withLimits({ batchSize: 3, minCoverage: 0 }))

    expect(outcome).toEqual({ kind: 'cancelled' })
  })

  it('caller cancellation wins over deadline exhaustion', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    // The transport mimics a real one: once the combined signal aborts (here
    // by the CALLER, before the 100 ms deadline), the request rejects.
    const { runner } = recording(async (request, index) => {
      if (index === 0) return answerAll(request)
      await new Promise(resolve => setTimeout(resolve, 60))
      if (request.signal.aborted) throw new DOMException('aborted', 'AbortError')
      return answerAll(request)
    })
    const outcome = await recommend(catalog(6), runner, withLimits({ batchSize: 3, timeoutMs: 100, minCoverage: 0 }), undefined, controller.signal)

    expect(outcome).toEqual({ kind: 'cancelled' })
  })

  it('stale identity beats deadline exhaustion', async () => {
    // The revalidate hook throws (the runtime's stale signal) while the second
    // batch is in flight past the deadline; the throw must win.
    const { runner } = recording(async (request, index) => {
      if (index === 0) return answerAll(request)
      await new Promise(resolve => setTimeout(resolve, 80))
      return answerAll(request)
    })
    // The revalidate hook throws from its third invocation (after batch 1's
    // post-await revalidation), while the deadline has already fired.
    let calls = 0
    const outcome2 = recommendSkills({
      task: TASK,
      scope: SCOPE,
      signal: new AbortController().signal,
      mode: 'active',
      candidates: catalog(6),
      limits: withLimits({ batchSize: 3, timeoutMs: 40, minCoverage: 0 }),
      routeAlias: ROUTE_ALIAS,
      revalidate: () => {
        calls += 1
        if (calls >= 3) throw new Error('stale')
      },
    }, runner)
    await expect(outcome2).rejects.toThrow('stale')
  })

  it('never caches a partial outcome', async () => {
    const cache = new RecommendationCache<RecommendationOutcome>({ limits: () => ({ maxEntries: 10, ttlMs: 60000 }) })
    let runs = 0
    const factory = async (): Promise<RecommendationOutcome> => {
      runs += 1
      return {
        kind: 'recommended',
        recommendations: [],
        decisionIds: [],
        judged: 3,
        eligible: 6,
      }
    }
    const first = await cache.run('k', factory)
    const second = await cache.run('k', factory)

    expect(first.status).toBe('ok')
    expect(second.status).toBe('ok')
    expect(runs).toBe(2)
    expect(cache.size).toBe(0)
  })

  it('caches a complete outcome', async () => {
    const cache = new RecommendationCache<RecommendationOutcome>({ limits: () => ({ maxEntries: 10, ttlMs: 60000 }) })
    let runs = 0
    const factory = async (): Promise<RecommendationOutcome> => {
      runs += 1
      return { kind: 'recommended', recommendations: [], decisionIds: [], judged: 6, eligible: 6 }
    }
    await cache.run('k', factory)
    await cache.run('k', factory)

    expect(runs).toBe(1)
    expect(cache.size).toBe(1)
  })
})

describe('C4 settings', () => {
  it('defaults min-coverage to 1 and parses valid overrides', () => {
    const parsed = parseRecommendationSettings(undefined)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.settings.minCoverage).toBe(1)
    expect(parsed.settings.maxCandidates).toBe(128)
    expect(parsed.settings.batchSize).toBe(16)
    expect(parsed.settings.maxInputTokens).toBe(8192)
    expect(parsed.settings.timeoutMs).toBe(5000)

    const overridden = parseRecommendationSettings({ mode: 'shadow', 'min-coverage': 0.8 })
    expect(overridden.ok).toBe(true)
    if (!overridden.ok) return
    expect(overridden.settings.minCoverage).toBe(0.8)
  })

  it('rejects out-of-range min-coverage values', () => {
    for (const value of [-0.1, 1.1, Number.NaN, 'x']) {
      const parsed = parseRecommendationSettings({ 'min-coverage': value })
      expect(parsed.ok).toBe(false)
    }
  })

  it('carries the widened ranges', () => {
    const wide = parseRecommendationSettings({
      'max-candidates': 256,
      'batch-size': 32,
      'timeout-ms': 10000,
    })
    expect(wide.ok).toBe(true)
    const narrow = parseRecommendationSettings({ 'max-candidates': 257 })
    expect(narrow.ok).toBe(false)
    expect(DEFAULT_RECOMMENDATION_SETTINGS.minCoverage).toBe(1)
  })
})
