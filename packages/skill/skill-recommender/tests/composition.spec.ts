/**
 * S1-06 skill recommendation at the wiring layer: the `recommend_skill` tool
 * composed with a real tool registry, a fake `skills` catalog, a fake
 * `settings` service and a scripted `systemoneDecisions` runner — no network,
 * no credentials, no skill bodies.
 *
 * Each test pins one row of the design's assertion table
 * (`docs/plans/2026-11-02-systemone-06-skill-recommendation.md`
 * § "State machine, ordering, and behavior", § "Cache, privacy, and failure
 * table" and § "Implementation tasks and acceptance"): `mode: off` costs zero
 * runner calls and zero body loads, an empty eligible pool is a valid empty
 * recommendation, a missing runner or an unfinished batch is unavailable, an
 * identity/catalog/mode change across an await discards the whole result,
 * cancellation publishes nothing, shadow keeps only `decisionIds`, duplicate
 * names and user-invocable-only skills never reach the runner, and same-key
 * callers share ONE runner call with independent cancellation.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import * as CcToolExecutor from '@dsh-cc/tools/executor'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as SkillRecommender from '../src/index.ts'
import { RECOMMEND_SKILL_NAME, toDescriptor } from '../src/index.ts'
import { RecommendationCache } from '../src/cache.ts'
import type { RecommendationOutcome } from '../src/recommend.ts'
import { createRecommendationRuntime } from '../src/runtime.ts'
import type { RecommendationRuntime } from '../src/runtime.ts'
import { parseRecommendationSettings } from '../src/settings.ts'
import type {
  SkillDecisionRequest,
  SkillDecisionRun,
  SkillRecommendationRouteIdentity,
  SkillRecommendationRunner,
  SkillRecommendationScope,
} from '../src/types.ts'

/** The scope a bound runner mints for the fake agent (watermark 3). */
const SCOPE: SkillRecommendationScope = { projectKey: 'proj', sessionId: 'sess', agentId: 'agent', originSeq: 3 }

/** A deliberately wide route: only `batch-size` groups the pool here. */
const WIDE_ROUTE: SkillRecommendationRouteIdentity = {
  provider: 'gw',
  model: 'gauge-model',
  revision: 'rev-1',
  perRequestTokens: 100_000,
  perQuestionTokens: 10_000,
  maxQuestions: 64,
  maxOutputTokens: 512,
}

/** One `SkillSummary` as a provider would expose it (model-invocable by default). */
function skill(name: string, overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name,
    description: `${name} description`,
    source: 'bundled',
    provider: 'provider',
    invocation: { modelInvocable: true, userInvocable: true },
    ...overrides,
  }
}

/**
 * The `skills` service double. `get` throws on purpose: the design forbids the
 * recommendation path from loading a body (§ "Candidate eligibility and
 * complete state"), so any body read fails the test loudly.
 */
class FakeSkills {
  calls: Array<{ cwd?: string }> = []

  getCalls = 0

  constructor(public candidates: readonly SkillSummary[]) {}

  async list(options: { cwd?: string; scope?: unknown } = {}): Promise<SkillSummary[]> {
    this.calls.push({ ...options.cwd !== undefined ? { cwd: options.cwd } : {} })
    return [...this.candidates]
  }

  get(): never {
    this.getCalls += 1
    throw new Error('recommend_skill must never load a skill body')
  }
}

/** A scripted stand-in for S1-02's `BoundDecisionRunner`. */
class FakeRunner implements SkillRecommendationRunner {
  readonly requests: SkillDecisionRequest[] = []

  /** The signals handed to the shared request (the coalesced run's own signal). */
  readonly signals: AbortSignal[] = []

  /** Every `scope(originSeq?)` argument, to pin the watermark computation. */
  readonly scopeArgs: Array<number | undefined> = []

  route: SkillRecommendationRouteIdentity | undefined = { ...WIDE_ROUTE }

  scopeValue: SkillRecommendationScope = { ...SCOPE }

  /** Answers one request; mutated per test. */
  answer: (request: SkillDecisionRequest) => SkillDecisionRun = request => ({
    status: 'answered',
    answers: answerAll(request) as never,
    decisionId: `decision-${this.requests.length}`,
  })

  /** Optional per-request hook, run before the answer resolves. */
  beforeAnswer: (request: SkillDecisionRequest) => Promise<void> | void = () => {}

  identifyRoute(): SkillRecommendationRouteIdentity | undefined {
    return this.route
  }

  scope(originSeq?: number): SkillRecommendationScope {
    this.scopeArgs.push(originSeq)
    return originSeq === undefined ? { ...this.scopeValue } : { ...this.scopeValue, originSeq }
  }

  async run(request: SkillDecisionRequest): Promise<SkillDecisionRun> {
    this.requests.push(request)
    this.signals.push(request.signal)
    await this.beforeAnswer(request)
    return this.answer(request)
  }
}

/** One answered batch: every skill relevant at `relevance`/`prerequisites`. */
function answerAll(
  request: SkillDecisionRequest,
  options: { relevance?: number; prerequisites?: number } = {},
): Record<string, unknown> {
  const state = request.state as { skills: Array<{ id: string }> }
  const answers: Record<string, unknown> = {}
  for (const entry of state.skills) {
    // `expectedScore` reads the probability vector, so the fake emits both.
    answers[`${entry.id}_relevance`] = {
      type: 'score',
      probabilities: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 1 },
      score: options.relevance ?? 4,
    }
    answers[`${entry.id}_prerequisites`] = { type: 'noul', noul: options.prerequisites ?? 0.9 }
  }
  return answers
}

/** The skill names the runner was asked about, across every batch. */
function sentNames(runner: FakeRunner): string[] {
  return runner.requests.flatMap(request =>
    (request.state as { skills: Array<{ name: string }> }).skills.map(entry => entry.name))
}

/** Minimal `settings` service double: one live raw section, no cascade. */
function fakeSettings(section: Record<string, unknown> | undefined) {
  return {
    register: () => ({ get: () => section }),
    get: () => section,
    describe: () => [],
  }
}

interface HostOptions {
  section?: Record<string, unknown> | undefined
  runner?: FakeRunner
  skills?: FakeSkills
  /** Provide a `skills` service at all (default true). */
  withSkills?: boolean
}

/** A host plane with the tool registry, the fake catalog and the runner double. */
async function host(options: HostOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CcToolExecutor)
  ctx.provide('settings', fakeSettings(options.section))
  const skills = options.skills ?? new FakeSkills([])
  if (options.withSkills !== false) ctx.provide('skills', skills)
  if (options.runner !== undefined) {
    ctx.provide('systemoneDecisions', { forAgent: () => options.runner })
  }
  const fiber = await ctx.plugin(SkillRecommender)
  return { ctx, skills, fiber }
}

/** A structural agent: only the session watermark and the header cwd matter. */
function fakeAgent(seq = 3, cwd = '/work'): Agent {
  return { id: 'agent-id', session: { seq, header: { cwd } } } as unknown as Agent
}

/**
 * The runtime on its own, with the same doubles: the tool executor turns a
 * caller's cancellation into its own abort result, so the design's `cancelled`
 * state is pinned here, one layer below the tool.
 */
function standaloneRuntime(options: {
  section: Record<string, unknown> | undefined
  runner: FakeRunner
  skills: FakeSkills
}): RecommendationRuntime {
  return createRecommendationRuntime({
    readSettings: () => {
      const parsed = parseRecommendationSettings(options.section)
      return parsed.ok ? parsed.settings : undefined
    },
    listCandidates: async () => options.skills.candidates.map(candidate => toDescriptor(candidate)),
    resolveRunner: () => options.runner,
    cache: new RecommendationCache<RecommendationOutcome>({ limits: () => ({ maxEntries: 128, ttlMs: 60000 }) }),
  })
}

interface RecommendValue {
  status: 'off' | 'shadow' | 'recommended' | 'unavailable' | 'cancelled'
  recommendations: Array<{ name: string; relevance: number; prerequisitesMet: number }>
  decisionIds: string[]
  advisory: true
}

let callCounter = 0

/** Execute `recommend_skill` through the real executor, as the model would. */
async function recommend(
  ctx: Context,
  task: string,
  // `null` means "no agent on the call at all"; omitted means the default agent.
  options: { agent?: Agent | null; signal?: AbortSignal } = {},
) {
  callCounter += 1
  const agent = options.agent === undefined ? fakeAgent() : options.agent
  return executeModelToolFixture(ctx, {
    signal: options.signal ?? new AbortController().signal,
    callId: ToolCallId(`recommend-${callCounter}`),
    name: RECOMMEND_SKILL_NAME,
    arguments: { task },
    ...agent === null ? {} : { agent },
  })
}

/** Execute `recommend_skill` and require a successful, non-error result. */
async function recommendOk(
  ctx: Context,
  task: string,
  options: { agent?: Agent | null; signal?: AbortSignal } = {},
) {
  const result = await recommend(ctx, task, options)
  expect(result.isError).toBe(false)
  return result as typeof result & { value: RecommendValue }
}

/** Let every pending promise chain reach its next await. */
function settle(ms = 10): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('mode off', () => {
  it('returns off with zero runner calls, zero catalog reads and zero body loads', async () => {
    const runner = new FakeRunner()
    const skills = new FakeSkills([skill('code-writer')])
    // The documented default is off; this host sets it explicitly.
    const { ctx } = await host({ section: { mode: 'off' }, runner, skills })

    const result = await recommendOk(ctx, 'write interface tests for the existing controller')

    expect(result.value.status).toBe('off')
    expect(result.value.recommendations).toEqual([])
    expect(result.value.decisionIds).toEqual([])
    expect(result.value.advisory).toBe(true)
    // Step 1: off returns before the catalog is even read.
    expect(runner.requests.length).toBe(0)
    expect(skills.calls.length).toBe(0)
    expect(skills.getCalls).toBe(0)
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect((result.content[0] as { text: string }).text).toContain('Explicit')
  })

  it('defaults to off when no settings section exists', async () => {
    const runner = new FakeRunner()
    const { ctx } = await host({ runner })

    const result = await recommendOk(ctx, 'anything')

    expect(result.value.status).toBe('off')
    expect(runner.requests.length).toBe(0)
  })
})

describe('candidate eligibility', () => {
  it('reports recommended with an empty list and zero runner calls for an empty catalog', async () => {
    const runner = new FakeRunner()
    const { ctx } = await host({ section: { mode: 'active' }, runner, skills: new FakeSkills([]) })

    const result = await recommendOk(ctx, 'write interface tests')

    expect(result.value.status).toBe('recommended')
    expect(result.value.recommendations).toEqual([])
    expect(runner.requests.length).toBe(0)
  })

  it('never puts a user-invocable-only skill in the model pool', async () => {
    const runner = new FakeRunner()
    const skills = new FakeSkills([
      skill('human-only', { invocation: { modelInvocable: false, userInvocable: true } }),
    ])
    const { ctx } = await host({ section: { mode: 'active' }, runner, skills })

    const result = await recommendOk(ctx, 'write interface tests')

    expect(result.value.status).toBe('recommended')
    expect(result.value.recommendations).toEqual([])
    expect(runner.requests.length).toBe(0)
  })

  it('drops a duplicate name group instead of choosing a provider, and inits the rest', async () => {
    const runner = new FakeRunner()
    const skills = new FakeSkills([
      skill('duplicate', { source: 'bundled', description: 'first provider copy' }),
      skill('duplicate', { source: 'project-dsh', description: 'second provider copy' }),
      skill('unique-one'),
    ])
    const { ctx } = await host({ section: { mode: 'active' }, runner, skills })

    const result = await recommendOk(ctx, 'write interface tests')

    expect(runner.requests.length).toBe(1)
    expect(sentNames(runner)).toEqual(['unique-one'])
    expect(result.value.recommendations.map(entry => entry.name)).toEqual(['unique-one'])
    expect(result.value.advisory).toBe(true)
    // The scoring path never loads a body: the catalog metadata is enough.
    expect(skills.getCalls).toBe(0)
  })

  it('passes the calling session cwd and watermark to the host seams', async () => {
    const runner = new FakeRunner()
    const skills = new FakeSkills([skill('unique-one')])
    const { ctx } = await host({ section: { mode: 'active' }, runner, skills })

    await recommendOk(ctx, 'write interface tests', { agent: fakeAgent(7, '/repo/worktree') })

    expect(skills.calls[0]?.cwd).toBe('/repo/worktree')
    // `originSeq` is the persisted session watermark (`Number(session.seq)`),
    // never `events.length`: the fake agent exposes no event list at all.
    expect(runner.scopeArgs[0]).toBe(7)
    expect(runner.requests[0]?.scope.originSeq).toBe(7)
  })
})

describe('unavailable outcomes', () => {
  it('is unavailable when no decision runner service is mounted', async () => {
    const skills = new FakeSkills([skill('code-writer')])
    const { ctx } = await host({ section: { mode: 'active' }, skills })

    const result = await recommendOk(ctx, 'write interface tests')

    expect(result.value.status).toBe('unavailable')
    expect(result.value.recommendations).toEqual([])
    expect(result.value.decisionIds).toEqual([])
    expect(skills.getCalls).toBe(0)
  })

  it('is unavailable when the call carries no agent', async () => {
    const runner = new FakeRunner()
    const skills = new FakeSkills([skill('code-writer')])
    const { ctx } = await host({ section: { mode: 'active' }, runner, skills })

    // No agent ⇒ no decision-service binding and no metering scope.
    const result = await recommend(ctx, 'write interface tests', { agent: null })

    expect(result.isError).toBe(false)
    expect((result as typeof result & { value: RecommendValue }).value.status).toBe('unavailable')
    expect(runner.requests.length).toBe(0)
  })

  it('is unavailable when the agent exposes no persisted watermark', async () => {
    const runner = new FakeRunner()
    const skills = new FakeSkills([skill('code-writer')])
    const { ctx } = await host({ section: { mode: 'active' }, runner, skills })

    const sessionless = { id: 'agent-id' } as unknown as Agent
    const result = await recommendOk(ctx, 'write interface tests', { agent: sessionless })

    expect(result.value.status).toBe('unavailable')
    expect(runner.requests.length).toBe(0)
  })

  it('is unavailable when the route identity cannot be resolved', async () => {
    const runner = new FakeRunner()
    runner.route = undefined
    const skills = new FakeSkills([skill('code-writer')])
    const { ctx } = await host({ section: { mode: 'active' }, runner, skills })

    const result = await recommendOk(ctx, 'write interface tests')

    expect(result.value.status).toBe('unavailable')
    expect(runner.requests.length).toBe(0)
  })

  it('is unavailable when the settings section is invalid, with zero runner calls', async () => {
    const runner = new FakeRunner()
    const skills = new FakeSkills([skill('code-writer')])
    const { ctx } = await host({ section: { mode: 'active', 'timeout-ms': 5 }, runner, skills })

    const result = await recommendOk(ctx, 'write interface tests')

    expect(result.value.status).toBe('unavailable')
    expect(runner.requests.length).toBe(0)
  })

  it('is unavailable when the catalog read fails', async () => {
    const runner = new FakeRunner()
    const skills = new FakeSkills([skill('code-writer')])
    skills.list = async () => { throw new Error('skill discovery failed') }
    const { ctx } = await host({ section: { mode: 'active' }, runner, skills })

    const result = await recommendOk(ctx, 'write interface tests')

    expect(result.value.status).toBe('unavailable')
    expect(runner.requests.length).toBe(0)
  })

  it('is unavailable when the task exceeds max-task-chars', async () => {
    const runner = new FakeRunner()
    const skills = new FakeSkills([skill('code-writer')])
    const { ctx } = await host({ section: { mode: 'active', 'max-task-chars': 64 }, runner, skills })

    const result = await recommendOk(ctx, 'x'.repeat(65))

    expect(result.value.status).toBe('unavailable')
    expect(runner.requests.length).toBe(0)
  })

  it('discards a complete batch 1 when batch 2 times out', async () => {
    const runner = new FakeRunner()
    runner.answer = request => (runner.requests.length === 1
      ? { status: 'answered', answers: answerAll(request, { relevance: 4, prerequisites: 0.95 }) as never, decisionId: 'd1' }
      : { status: 'unavailable', reason: 'timeout', decisionId: 'd2' })
    const skills = new FakeSkills([skill('alpha'), skill('beta')])
    const { ctx } = await host({
      section: { mode: 'active', 'batch-size': 1 },
      runner,
      skills,
    })

    const result = await recommendOk(ctx, 'write interface tests')

    expect(runner.requests.length).toBe(2)
    expect(result.value.status).toBe('unavailable')
    expect(result.value.recommendations).toEqual([])
    expect(result.value.decisionIds).toEqual([])
  })

  it('is unavailable when a batch answers without every question', async () => {
    const runner = new FakeRunner()
    runner.answer = request => ({ status: 'answered', answers: {}, decisionId: 'd1' })
    const skills = new FakeSkills([skill('code-writer')])
    const { ctx } = await host({ section: { mode: 'active' }, runner, skills })

    const result = await recommendOk(ctx, 'write interface tests')

    expect(result.value.status).toBe('unavailable')
    expect(result.value.recommendations).toEqual([])
  })
})

describe('post-await revalidation', () => {
  it('discards the recommendation when the route identity changes', async () => {
    const runner = new FakeRunner()
    runner.answer = request => {
      // The deployment revision rotates while the answer is in flight.
      runner.route = { ...WIDE_ROUTE, revision: 'rev-2' }
      return { status: 'answered', answers: answerAll(request) as never, decisionId: 'd1' }
    }
    const skills = new FakeSkills([skill('code-writer')])
    const { ctx } = await host({ section: { mode: 'active' }, runner, skills })

    const result = await recommendOk(ctx, 'write interface tests')

    expect(result.value.status).toBe('unavailable')
    expect(result.value.recommendations).toEqual([])
    // Changed identity is not a reason to ask again inside this request.
    expect(runner.requests.length).toBe(1)
  })

  it('discards the recommendation when the catalog hash changes before publishing', async () => {
    const runner = new FakeRunner()
    const skills = new FakeSkills([skill('code-writer')])
    const original = skills.list.bind(skills)
    // First read (snapshot) and later read (publish gate) disagree.
    skills.list = async options => (skills.calls.length === 0
      ? original(options)
      : [{ ...skill('code-writer'), description: 'edited while judging' }])
    const { ctx } = await host({ section: { mode: 'active' }, runner, skills })

    const result = await recommendOk(ctx, 'write interface tests')

    expect(result.value.status).toBe('unavailable')
    expect(result.value.recommendations).toEqual([])
    expect(runner.requests.length).toBe(1)
  })

  it('discards the recommendation when the mode changes during the judgment', async () => {
    const runner = new FakeRunner()
    const section: Record<string, unknown> = { mode: 'active' }
    runner.beforeAnswer = () => { section.mode = 'off' }
    const skills = new FakeSkills([skill('code-writer')])
    const { ctx } = await host({ section, runner, skills })

    const result = await recommendOk(ctx, 'write interface tests')

    expect(result.value.status).toBe('unavailable')
    expect(result.value.recommendations).toEqual([])
    expect(runner.requests.length).toBe(1)
  })
})

describe('shadow', () => {
  it('keeps decisionIds for the audit trail but publishes no recommendations', async () => {
    const runner = new FakeRunner()
    const skills = new FakeSkills([skill('code-writer')])
    const { ctx } = await host({ section: { mode: 'shadow' }, runner, skills })

    const result = await recommendOk(ctx, 'write interface tests')

    expect(result.value.status).toBe('shadow')
    expect(result.value.recommendations).toEqual([])
    expect(result.value.decisionIds).toEqual(['decision-1'])
    expect(result.value.advisory).toBe(true)
    expect(runner.requests.length).toBe(1)
  })
})

describe('recommended', () => {
  it('returns only above-threshold skills, ordered by relevance then name', async () => {
    const runner = new FakeRunner()
    runner.answer = request => {
      const state = request.state as { skills: Array<{ id: string; name: string }> }
      const answers: Record<string, unknown> = {}
      for (const entry of state.skills) {
        // `alpha` is exact, `beta` is direct, `gamma` is tangential.
        const score = entry.name === 'alpha' ? 4 : entry.name === 'beta' ? 3.2 : 1.5
        answers[`${entry.id}_relevance`] = { type: 'score', score }
        answers[`${entry.id}_prerequisites`] = { type: 'noul', noul: 0.9 }
      }
      return { status: 'answered', answers: answers as never, decisionId: 'd1' }
    }
    const skills = new FakeSkills([skill('gamma'), skill('beta'), skill('alpha')])
    const { ctx } = await host({ section: { mode: 'active' }, runner, skills })

    const result = await recommendOk(ctx, 'write interface tests')

    expect(result.value.status).toBe('recommended')
    expect(result.value.recommendations.map(entry => entry.name)).toEqual(['alpha', 'beta'])
    expect(result.value.recommendations[0]?.relevance).toBe(4)
    expect(result.value.recommendations[0]?.prerequisitesMet).toBe(0.9)
    expect(result.value.decisionIds).toEqual(['d1'])
    expect(skills.getCalls).toBe(0)
  })

  it('rejects an empty task instead of judging it', async () => {
    const runner = new FakeRunner()
    const skills = new FakeSkills([skill('code-writer')])
    const { ctx } = await host({ section: { mode: 'active' }, runner, skills })

    const result = await recommend(ctx, '   ')

    expect(result.isError).toBe(true)
    expect(runner.requests.length).toBe(0)
  })
})

describe('cancellation', () => {
  it('publishes nothing when the caller cancels mid-judgment', async () => {
    const runner = new FakeRunner()
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    runner.beforeAnswer = async () => { await gate }
    const skills = new FakeSkills([skill('code-writer')])
    const { ctx } = await host({ section: { mode: 'active' }, runner, skills })

    const controller = new AbortController()
    const pending = recommend(ctx, 'write interface tests', { signal: controller.signal })
    await settle()
    expect(runner.requests.length).toBe(1)
    controller.abort()
    const result = await pending
    release()

    // The executor reports the cancellation as an abort; no recommendation,
    // decisionId or body load was published on the caller's behalf.
    expect(result.isError).toBe(true)
    expect(result.value).toBeUndefined()
    expect(skills.getCalls).toBe(0)
  })

  it('reports the cancelled state from the runtime when the caller leaves', async () => {
    const runner = new FakeRunner()
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    runner.beforeAnswer = async () => { await gate }
    const skills = new FakeSkills([skill('code-writer')])
    const runtime = standaloneRuntime({ section: { mode: 'active' }, runner, skills })

    const controller = new AbortController()
    const pending = runtime.recommend({ task: 'write interface tests', actor: fakeAgent(), signal: controller.signal })
    await settle()
    expect(runner.requests.length).toBe(1)
    controller.abort()
    const result = await pending
    release()

    expect(result.status).toBe('cancelled')
    expect(result.recommendations).toEqual([])
    expect(result.decisionIds).toEqual([])
    expect(result.advisory).toBe(true)
  })
})

describe('same-key coalescing (decision-gate-coalescing REQ-1..REQ-6)', () => {
  it('answers two identical concurrent calls with ONE runner request', async () => {
    const runner = new FakeRunner()
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    runner.beforeAnswer = async () => { await gate }
    const skills = new FakeSkills([skill('code-writer')])
    const { ctx } = await host({ section: { mode: 'active' }, runner, skills })

    const first = recommend(ctx, 'write interface tests')
    const second = recommend(ctx, 'write interface tests')
    await settle()
    // Both callers are waiting on the same in-flight judgment.
    expect(runner.requests.length).toBe(1)
    release()
    const results = await Promise.all([first, second])

    expect(runner.requests.length).toBe(1)
    for (const result of results) {
      expect(result.isError).toBe(false)
      const value = (result as typeof result & { value: RecommendValue }).value
      expect(value.status).toBe('recommended')
      expect(value.recommendations.map(entry => entry.name)).toEqual(['code-writer'])
    }
  })

  it('answers a repeated identical call from the cache with ONE runner request', async () => {
    const runner = new FakeRunner()
    const skills = new FakeSkills([skill('code-writer')])
    const { ctx } = await host({ section: { mode: 'active' }, runner, skills })

    const first = await recommendOk(ctx, 'write interface tests')
    const second = await recommendOk(ctx, 'write interface tests')

    expect(first.value.status).toBe('recommended')
    expect(second.value.status).toBe('recommended')
    expect(second.value.recommendations).toEqual(first.value.recommendations)
    expect(runner.requests.length).toBe(1)
  })

  it('cancels one waiter independently while the shared request still answers the other', async () => {
    const runner = new FakeRunner()
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    runner.beforeAnswer = async () => { await gate }
    const skills = new FakeSkills([skill('code-writer')])
    const { ctx } = await host({ section: { mode: 'active' }, runner, skills })

    const leaving = new AbortController()
    const first = recommend(ctx, 'write interface tests', { signal: leaving.signal })
    const second = recommend(ctx, 'write interface tests')
    await settle()
    expect(runner.requests.length).toBe(1)

    leaving.abort()
    release()
    const [cancelled, survivor] = await Promise.all([first, second])

    expect(cancelled.isError).toBe(true)
    expect((survivor as typeof survivor & { value: RecommendValue }).value.status).toBe('recommended')
    // One waiter remains, so the shared request was never aborted.
    expect(runner.signals[0]?.aborted).toBe(false)
  })

  it('aborts the shared runner request only when every waiter cancels', async () => {
    const runner = new FakeRunner()
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    runner.beforeAnswer = async () => { await gate }
    const skills = new FakeSkills([skill('code-writer')])
    const { ctx } = await host({ section: { mode: 'active' }, runner, skills })

    const firstLeaving = new AbortController()
    const secondLeaving = new AbortController()
    const first = recommend(ctx, 'write interface tests', { signal: firstLeaving.signal })
    const second = recommend(ctx, 'write interface tests', { signal: secondLeaving.signal })
    await settle()
    expect(runner.requests.length).toBe(1)

    firstLeaving.abort()
    secondLeaving.abort()
    const results = await Promise.all([first, second])
    release()

    // Each caller is cancelled independently — and with no waiter left, the
    // shared request itself is aborted (REQ-2).
    for (const result of results) {
      expect(result.isError).toBe(true)
      expect(result.value).toBeUndefined()
    }
    expect(runner.signals[0]?.aborted).toBe(true)
  })
})

describe('unload', () => {
  it('aborts the in-flight judgment and unregisters the tool', async () => {
    const runner = new FakeRunner()
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    runner.beforeAnswer = async () => { await gate }
    const skills = new FakeSkills([skill('code-writer')])
    const { ctx, fiber } = await host({ section: { mode: 'active' }, runner, skills })

    const names = async () => (await ctx.systemPrompt.assemble({})).tools.map(tool => tool.name)
    expect(await names()).toContain(RECOMMEND_SKILL_NAME)

    const pending = recommend(ctx, 'write interface tests')
    await settle()
    expect(runner.requests.length).toBe(1)

    await fiber.dispose()
    const result = await pending
    release()

    // The unload path aborts the shared request and publishes nothing.
    expect(result.isError).toBe(false)
    expect((result as typeof result & { value: RecommendValue }).value.status).toBe('cancelled')
    expect((result as typeof result & { value: RecommendValue }).value.recommendations).toEqual([])
    expect((result as typeof result & { value: RecommendValue }).value.decisionIds).toEqual([])
    expect(runner.signals[0]?.aborted).toBe(true)
    expect(await names()).not.toContain(RECOMMEND_SKILL_NAME)
  })
})
