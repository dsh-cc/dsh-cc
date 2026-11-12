/**
 * Context-routing v2 integration spec (S1-09, design
 * docs/plans/2026-11-02-systemone-09-moa-context-routing.md §"Modes and
 * failure table", §"Implementation and acceptance").
 *
 * Drives the real admission seam (`routeBeforeAdmission` + `noteClaimed`) of
 * the shared rig with a fake `BoundDecisionRunner` injected through the new
 * `RouterDeps.contextDecisions` seam, so every mode, every fallback reason and
 * the whole post-await discard matrix is pinned without a network call.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonl } from '@dsh-cc/sidecar-io'
import {
  canonicalJson,
  estimateSystemOneTokens,
  S1_ENVELOPE_TOKENS,
  S1_MARGIN_TOKENS,
} from '@dsh-cc/systemone'
import type {
  BoundDecisionRunner,
  DecisionRequest,
  DecisionRouteIdentity,
  DecisionRun,
  DecisionScope,
} from '@dsh-cc/systemone'
import {
  CONTEXT_ROUTE_FEATURE,
  CONTEXT_ROUTE_INSTRUCTIONS,
  CONTEXT_ROUTE_POLICY_VERSION,
  CONTEXT_ROUTE_QUESTION,
  CONTEXT_ROUTE_QUESTION_VERSION,
} from '../src/context-routing.ts'
import { ROUTING_QUESTION } from '../src/router-tiers.ts'
import { buildRoutingContext, type RoutingContext } from '../src/routing-context.ts'
import { resetRuntimeCore } from '../src/runtime-state.ts'
import { BOOT_PAIR, DRAFT_PROBABILITIES, escalationOpening, makeRig, textOf, userOpening, type Rig } from './rig.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  resetRuntimeCore()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'moa-context-'))
  dirs.push(dir)
  return dir
}

const ledgerPath = (): string => join(tempDir(), 'routing.jsonl')

/** The fake route identity: all four numeric bounds present. */
const IDENTITY: DecisionRouteIdentity = {
  provider: 'gw',
  model: 'gw/judge-model',
  revision: 'rev-1',
  perRequestTokens: 16384,
  perQuestionTokens: 16384,
  maxQuestions: 4,
  maxOutputTokens: 1024,
}

/** Design example 1: a confident argmax with a long upper tail → blueprint. */
const EDGE = { sketch: 0.65, draft: 0.2, blueprint: 0.1, masterplan: 0.05 }

/** Design example 2: below `min-top-probability` → live selection. */
const FLAT = { sketch: 0.28, draft: 0.27, blueprint: 0.25, masterplan: 0.2 }

const scopeOf = (originSeq: number): DecisionScope => ({
  projectKey: 'p'.repeat(64),
  sessionId: 'session-1',
  agentId: 'agent-1',
  originSeq,
})

function answered(probabilities: Record<string, number>): DecisionRun {
  return {
    status: 'answered',
    answers: { route: { type: 'choice', choice: 'blueprint', probabilities } },
    model: IDENTITY.model,
    usage: { input_tokens: 100, output_tokens: 5 },
    decisionId: 'decision-1',
    inputHash: 'hash-1',
  }
}

interface FakeRunner {
  runner: BoundDecisionRunner
  /** One entry per `run` call (the wire request as received). */
  requests: DecisionRequest[]
  /** The `originSeq` of every `scope(...)` call. */
  scopes: (number | undefined)[]
  /** How many times the identity was resolved (admission + re-check). */
  readonly identifyCalls: number
}

function fakeRunner(options: {
  probabilities?: Record<string, number>
  identity?: (call: number) => DecisionRouteIdentity | undefined
  run?: (request: DecisionRequest) => Promise<DecisionRun>
} = {}): FakeRunner {
  const requests: DecisionRequest[] = []
  const scopes: (number | undefined)[] = []
  let identifyCalls = 0
  const identity = options.identity ?? ((): DecisionRouteIdentity | undefined => IDENTITY)
  const probabilities = options.probabilities ?? EDGE
  const runner: BoundDecisionRunner = {
    scope(originSeq?: number): DecisionScope {
      scopes.push(originSeq)
      return scopeOf(originSeq ?? 0)
    },
    identifyRoute(): DecisionRouteIdentity | undefined {
      identifyCalls += 1
      return identity(identifyCalls)
    },
    run: (request: DecisionRequest): Promise<DecisionRun> => {
      requests.push(request)
      return options.run === undefined ? Promise.resolve(answered(probabilities)) : options.run(request)
    },
  }
  return {
    runner,
    requests,
    scopes,
    get identifyCalls() {
      return identifyCalls
    },
  }
}

/** Give the rig's fake session a durable watermark and a log snapshot. */
function sessionOf(rig: Rig, seq: number, events: readonly unknown[] = []): void {
  const session = rig.agent.session as unknown as { seq: number; snapshotEvents(): readonly unknown[] }
  session.seq = seq
  session.snapshotEvents = () => events
}

/** The v2 sidecar rows of the rig's ledger (legacy rows share the file). */
async function routeRows(rig: Rig): Promise<Record<string, unknown>[]> {
  const rows = await readJsonl<Record<string, unknown>>(rig.ledger)
  return rows.filter((row) => row.type === 'route')
}

describe('context-routing v2 — off is the legacy path', () => {
  it('mode off: zero v2 calls and a sidecar row with no v2 field', async () => {
    const runner = fakeRunner()
    const rig = makeRig({ ledger: ledgerPath(), contextDecisions: () => runner.runner })
    sessionOf(rig, 5)
    const opening = userOpening('CURRENT TURN TEXT')
    await rig.admit(opening)
    await rig.claim(1, [opening])
    expect(runner.identifyCalls).toBe(0)
    expect(runner.requests).toHaveLength(0)
    // Byte-identical legacy behaviour: one argmax classify, tier draft.
    expect(rig.classifyStates).toEqual(['CURRENT TURN TEXT'])
    expect(rig.agent.model.current()).toMatchObject({ provider: 'mock', model: 'tier-draft' })
    const rows = await routeRows(rig)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tier: 'draft',
      argmaxTier: 'draft',
      probabilities: DRAFT_PROBABILITIES,
      truncated: false,
      turnId: 1,
    })
    expect(rows[0]!.v2).toBeUndefined()
    expect(rows[0]!.mode).toBeUndefined()
    expect(rows[0]!.fallbackReason).toBeUndefined()
  })
})

describe('context-routing v2 — shadow records only', () => {
  it('records the v2 suggestion while the legacy argmax still decides the model', async () => {
    const runner = fakeRunner()
    const rig = makeRig({ ledger: ledgerPath(), contextDecisions: () => runner.runner })
    rig.settings.contextRouting.mode = 'shadow'
    sessionOf(rig, 7)
    const opening = userOpening('continue the migration')
    await rig.admit(opening)
    await rig.claim(1, [opening])

    // The double-call cost is accepted: legacy AND v2 both ran.
    expect(rig.classifyStates).toEqual(['continue the migration'])
    expect(runner.requests).toHaveLength(1)
    // Legacy (draft argmax) owns the applied model; the v2 pick is blueprint.
    expect(rig.agent.model.current()).toMatchObject({ provider: 'mock', model: 'tier-draft' })

    const request = runner.requests[0]!
    expect(request).toMatchObject({
      feature: CONTEXT_ROUTE_FEATURE,
      mode: 'shadow',
      routeAlias: 'gauge',
      questionVersion: CONTEXT_ROUTE_QUESTION_VERSION,
      policyVersion: CONTEXT_ROUTE_POLICY_VERSION,
      maxInputTokens: rig.settings.contextRouting.maxInputTokens,
      timeoutMs: rig.settings.contextRouting.timeoutMs,
    })
    expect(request.scope.originSeq).toBe(7)
    expect(runner.scopes).toContain(7)
    // The question carries the legacy criteria labels and the NEW instructions.
    const question = request.questions.route!
    expect(question.type).toBe('choice')
    expect(question.criteria).toEqual(ROUTING_QUESTION.criteria)
    expect(question.instructions).toBe(CONTEXT_ROUTE_INSTRUCTIONS)
    expect(question.instructions).not.toBe(ROUTING_QUESTION.instructions)

    const row = (await routeRows(rig))[0]!
    expect(row).toMatchObject({
      mode: 'shadow',
      v2: true,
      tier: 'draft',
      argmaxTier: 'draft',
      appliedTier: 'draft',
      suggestedTier: 'blueprint',
      suggestedProbabilities: EDGE,
      probabilities: DRAFT_PROBABILITIES,
    })
    expect(typeof row.v2LatencyMs).toBe('number')
    expect(row.fallbackReason).toBeUndefined()
  })
})

describe('context-routing v2 — active decides', () => {
  it('a confident edge distribution routes blueprint and one status row agrees', async () => {
    const runner = fakeRunner()
    const rig = makeRig({ ledger: ledgerPath(), contextDecisions: () => runner.runner })
    rig.settings.contextRouting.mode = 'active'
    sessionOf(rig, 9)
    const opening = userOpening('design the multi-module migration')
    await rig.admit(opening)
    await rig.claim(1, [opening])

    // v2 only: no legacy classifier call at all.
    expect(rig.classifyStates).toHaveLength(0)
    expect(runner.requests).toHaveLength(1)
    expect(runner.requests[0]!.mode).toBe('active')
    expect(rig.agent.model.current()).toMatchObject({ provider: 'mock', model: 'tier-blueprint' })

    const row = (await routeRows(rig))[0]!
    expect(row).toMatchObject({
      mode: 'active',
      v2: true,
      tier: 'blueprint',
      appliedTier: 'blueprint',
      suggestedTier: 'blueprint',
      argmaxTier: 'blueprint',
      probabilities: EDGE,
      truncated: false,
    })
    expect(typeof row.latencyMs).toBe('number')

    const delivered = await rig.deliverRows()
    expect(delivered.map(textOf)).toEqual(['moa: routed → blueprint (tier-blueprint)'])
  })

  it('a flat distribution falls back to the live selection with a fixed reason', async () => {
    const runner = fakeRunner({ probabilities: FLAT })
    const rig = makeRig({ ledger: ledgerPath(), contextDecisions: () => runner.runner })
    rig.settings.contextRouting.mode = 'active'
    sessionOf(rig, 3)
    const opening = userOpening('do the second option')
    await rig.admit(opening)
    await rig.claim(1, [opening])

    // maxP 0.28 < minTopProbability 0.6 → never force masterplan.
    expect(runner.requests).toHaveLength(1)
    expect(rig.agent.model.selections).toEqual([])
    expect(rig.agent.model.current()).toMatchObject({ provider: BOOT_PAIR.provider, model: BOOT_PAIR.model })
    const row = (await routeRows(rig))[0]!
    expect(row.fallbackReason).toBe('below-min-top-probability')
    expect(row.tier).toBeUndefined()
    expect(await rig.deliverRows()).toEqual([])
  })

  it('an absent executor serves live with NO legacy classifier call', async () => {
    const rig = makeRig({ ledger: ledgerPath() })
    rig.settings.contextRouting.mode = 'active'
    sessionOf(rig, 4)
    const opening = userOpening('refactor the router')
    await rig.admit(opening)
    await rig.claim(1, [opening])

    // The design's "active but unconfigured" row: no extra legacy request.
    expect(rig.classifyStates).toEqual([])
    expect(rig.agent.model.selections).toEqual([])
    const row = (await routeRows(rig))[0]!
    expect(row.fallbackReason).toBe('executor-unavailable')
    expect(row.mode).toBe('active')
  })

  it('a whitespace current request is not classified', async () => {
    const runner = fakeRunner()
    const rig = makeRig({ ledger: ledgerPath(), contextDecisions: () => runner.runner })
    rig.settings.contextRouting.mode = 'active'
    sessionOf(rig, 2)
    const opening = userOpening('   \n  ')
    await rig.admit(opening)
    await rig.claim(1, [opening])
    expect(runner.identifyCalls).toBe(0)
    expect(runner.requests).toHaveLength(0)
    expect((await routeRows(rig))[0]!.fallbackReason).toBe('whitespace-request')
  })

  it('an oversized current request (>8000 codepoints) serves live without a call', async () => {
    const runner = fakeRunner()
    const rig = makeRig({ ledger: ledgerPath(), contextDecisions: () => runner.runner })
    rig.settings.contextRouting.mode = 'active'
    sessionOf(rig, 2)
    const opening = userOpening('x'.repeat(8001))
    await rig.admit(opening)
    await rig.claim(1, [opening])

    expect(runner.identifyCalls).toBe(0)
    expect(runner.requests).toHaveLength(0)
    expect(rig.agent.model.selections).toEqual([])
    const row = (await routeRows(rig))[0]!
    expect(row.fallbackReason).toBe('oversized-current-request')
    expect(row.tier).toBeUndefined()
  })
})

describe('context-routing v2 — post-await discard matrix', () => {
  it('a superseded generation applies nothing and writes nothing', async () => {
    let runs = 0
    const runner = fakeRunner({
      run: (request) => {
        runs += 1
        // The first admission never settles on its own: only the abort of the
        // next admission ends it (the deferred-Promise drive).
        if (runs === 1) {
          return new Promise<DecisionRun>((resolve) => {
            request.signal.addEventListener('abort', () => resolve({ status: 'unavailable', reason: 'cancelled', decisionId: 'd-1' }))
          })
        }
        return Promise.resolve(answered(EDGE))
      },
    })
    const rig = makeRig({ ledger: ledgerPath(), contextDecisions: () => runner.runner })
    rig.settings.contextRouting.mode = 'active'
    sessionOf(rig, 6)
    let firstSignal: AbortSignal | undefined
    const first = userOpening('first admission')
    const second = userOpening('second admission')
    const firstAdmission = rig.admit(first).then(() => {
      firstSignal = runner.requests[0]?.signal
    })
    const secondAdmission = rig.admit(second)
    await Promise.all([firstAdmission, secondAdmission])
    expect(firstSignal?.aborted).toBe(true)

    // Only the newest admission applied: exactly one durable select, and the
    // stale one parked nothing (so exactly one row at claim).
    expect(rig.agent.model.selections).toHaveLength(1)
    expect(rig.agent.model.current()).toMatchObject({ provider: 'mock', model: 'tier-blueprint' })
    await rig.claim(1, [second])
    const rows = await routeRows(rig)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.mode).toBe('active')
  })

  it('a settings change between capture and settle discards the answer', async () => {
    let rig: Rig
    const runner = fakeRunner({
      run: async () => {
        // Simulate a hot reload landing while the classification is in flight.
        rig.settings.contextRouting.minTopProbability = 0.95
        return answered(EDGE)
      },
    })
    rig = makeRig({ ledger: ledgerPath(), contextDecisions: () => runner.runner })
    rig.settings.contextRouting.mode = 'active'
    sessionOf(rig, 8)
    const opening = userOpening('summarize the whole design')
    await rig.admit(opening)
    await rig.claim(1, [opening])

    expect(rig.agent.model.selections).toEqual([])
    const row = (await routeRows(rig))[0]!
    expect(row.fallbackReason).toBe('settings-changed')
    expect(row.tier).toBeUndefined()
  })

  it('a route identity change across the await discards the answer', async () => {
    const runner = fakeRunner({
      identity: (call) => (call === 1 ? IDENTITY : { ...IDENTITY, model: 'gw/rotated-model' }),
    })
    const rig = makeRig({ ledger: ledgerPath(), contextDecisions: () => runner.runner })
    rig.settings.contextRouting.mode = 'active'
    sessionOf(rig, 6)
    const opening = userOpening('migrate the settings section')
    await rig.admit(opening)
    await rig.claim(1, [opening])

    expect(runner.identifyCalls).toBeGreaterThanOrEqual(2)
    expect(rig.agent.model.selections).toEqual([])
    const row = (await routeRows(rig))[0]!
    expect(row.fallbackReason).toBe('identity-changed')
  })

  it('a numeric-bound change (perRequestTokens) also counts as an identity change', async () => {
    const runner = fakeRunner({
      identity: (call) => (call === 1 ? IDENTITY : { ...IDENTITY, perRequestTokens: IDENTITY.perRequestTokens * 2 }),
    })
    const rig = makeRig({ ledger: ledgerPath(), contextDecisions: () => runner.runner })
    rig.settings.contextRouting.mode = 'active'
    sessionOf(rig, 6)
    const opening = userOpening('add tests for the dispatcher')
    await rig.admit(opening)
    await rig.claim(1, [opening])
    expect((await routeRows(rig))[0]!.fallbackReason).toBe('identity-changed')
  })
})

describe('context-routing v2 — scope guards stay before v2', () => {
  it('a subagent agent never reaches the v2 call', async () => {
    const runner = fakeRunner()
    const rig = makeRig({ ledger: ledgerPath(), contextDecisions: () => runner.runner })
    rig.settings.contextRouting.mode = 'active'
    rig.agent.session.header.origin = 'subagent'
    sessionOf(rig, 3)
    await rig.admit(userOpening('child task'))
    expect(runner.identifyCalls).toBe(0)
    expect(runner.requests).toHaveLength(0)
    expect(await routeRows(rig)).toEqual([])
  })

  it('an escalation-retry turn keeps the floor path with no v2 call', async () => {
    const runner = fakeRunner()
    const rig = makeRig({ ledger: ledgerPath(), contextDecisions: () => runner.runner })
    rig.settings.contextRouting.mode = 'active'
    sessionOf(rig, 5)
    const retry = escalationOpening('moa: draft → blueprint, first answer rejected by judge', 1, 1, 2)
    await rig.admit(retry)
    await rig.claim(1, [retry])
    expect(runner.identifyCalls).toBe(0)
    expect(runner.requests).toHaveLength(0)
    expect(rig.classifyStates).toEqual([])
  })
})

describe('context-routing v2 — budget pre-fit', () => {
  const openingText = 'now continue the migration'
  const events: readonly unknown[] = [
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'first request' }] } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'second request' }] } },
    { seq: 3, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'A'.repeat(500) }] } } },
    { seq: 4, type: 'tool/call', data: { turn: 1, name: 'read_file', arguments: '{"path":"/secret"}' } },
  ]
  const estimate = (context: RoutingContext): number =>
    S1_ENVELOPE_TOKENS
    + estimateSystemOneTokens(canonicalJson(context))
    + estimateSystemOneTokens(canonicalJson({ route: CONTEXT_ROUTE_QUESTION }))
    + S1_MARGIN_TOKENS

  it('drops the assistant entry first when that is what makes the state fit', async () => {
    const runner = fakeRunner()
    const rig = makeRig({ ledger: ledgerPath(), contextDecisions: () => runner.runner })
    rig.settings.contextRouting.mode = 'active'
    sessionOf(rig, 10, events)
    const full = buildRoutingContext({ openingText, events, watermark: 10 })!
    const { priorAssistantAnswer: _dropped, ...rest } = full
    const withoutAssistant: RoutingContext = { ...rest, omitted: { ...full.omitted, assistant: true } }
    // Exactly the budget the state fits in only after the assistant drop.
    rig.settings.contextRouting.maxInputTokens = estimate(withoutAssistant)

    const opening = userOpening(openingText)
    await rig.admit(opening)
    await rig.claim(1, [opening])

    expect(runner.requests).toHaveLength(1)
    const state = runner.requests[0]!.state as RoutingContext
    expect(state.priorAssistantAnswer).toBeUndefined()
    expect(state.omitted.assistant).toBe(true)
    expect(state.currentRequest).toBe(openingText)
    expect(rig.agent.model.current()).toMatchObject({ provider: 'mock', model: 'tier-blueprint' })
  })

  it('never fitting serves live with the fixed budget reason and no call', async () => {
    const runner = fakeRunner()
    const rig = makeRig({ ledger: ledgerPath(), contextDecisions: () => runner.runner })
    rig.settings.contextRouting.mode = 'active'
    sessionOf(rig, 10, events)
    rig.settings.contextRouting.maxInputTokens = 40
    const opening = userOpening('x'.repeat(4000))
    await rig.admit(opening)
    await rig.claim(1, [opening])

    expect(runner.requests).toHaveLength(0)
    expect(rig.agent.model.selections).toEqual([])
    const row = (await routeRows(rig))[0]!
    expect(row.fallbackReason).toBe('budget')
    expect(row.tier).toBeUndefined()
  })

  it('a runner-unavailable reason is copied verbatim into the row', async () => {
    const runner = fakeRunner({
      run: () => Promise.resolve({ status: 'unavailable', reason: 'timeout', decisionId: 'd-2' }),
    })
    const rig = makeRig({ ledger: ledgerPath(), contextDecisions: () => runner.runner })
    rig.settings.contextRouting.mode = 'active'
    sessionOf(rig, 11, events)
    const opening = userOpening(openingText)
    await rig.admit(opening)
    await rig.claim(1, [opening])
    expect(rig.agent.model.selections).toEqual([])
    expect((await routeRows(rig))[0]!.fallbackReason).toBe('timeout')
  })
})
