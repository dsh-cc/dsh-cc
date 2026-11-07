/**
 * Promoted live-probe tests (design §8; harness-0.2.2 D3.2 form): P1 (the
 * durable tier selection lands on EVERY step of a 2-step tool-call turn,
 * with exactly ONE classify at admission), P1b (the classify status row is
 * injected via the claim bind and the NEXT admission classifies the genuine
 * user text, never the notice), P3a (no re-entry: agent/request firings
 * equal the step count and the classify runs once — the router mounts NO
 * agent/request listener at all now), P3b (System One failure → the
 * user/base pair is served), plus the grok r6 capture fixture (claimed
 * batch = [leading notice, escalation followup]; the retry floor restores
 * without classify).
 *
 * Driven against the real agent loop + MockAdapter. The admission seam call
 * mirrors the driver's submit path (routeBeforeAdmission before followup);
 * the judge's pre-followup select is emulated where a fixture needs an
 * escalation turn.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage, type LlmCallConfig, type LlmModelReasoningInfo, type UserMessage } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import { createRequestRouter, type RouterDeps } from '../src/router.ts'
import { resetRuntimeCore, setRuntimeCore } from '../src/runtime-state.ts'
import { ArmingMachine, DEFAULT_MOA_SETTINGS, EscalationBookkeeping, type MoaCore } from '../src/index.ts'
import { escalationOpening, GAUGE_ROUTE, noticeOpening, routes as tierRoutes } from './rig.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  resetRuntimeCore()
})

const REASONING = {
  efforts: [
    { id: 'low', name: 'low' },
    { id: 'max', name: 'max' },
  ],
} as unknown as LlmModelReasoningInfo

type Script = ConstructorParameters<typeof MockAdapter>[0]
type RequestNext = () => Promise<LlmCallConfig>

const DRAFT_PROBABILITIES = { sketch: 0.05, draft: 0.7, blueprint: 0.15, masterplan: 0.1 }

interface Wire {
  core: MoaCore
  router: ReturnType<typeof createRequestRouter>
  classifyStates: string[]
  injected: { text: string; source: unknown }[]
  payloads: { turn: number; step: number }[]
}

/**
 * Wire the production capture + router listeners onto the agent loop exactly
 * as `apply` does (D3.2 form: claimed bind + pre-step row splice ONLY — the
 * request overlay and assemble seams are gone) — with fake seams (fake
 * ModelRoutes + canned System One).
 */
async function setup(mainScript: Script, options: { probabilities?: Record<string, number>; failFetch?: Error } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-moa-router-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })

  const core: MoaCore = {
    arming: new ArmingMachine(() => true),
    bookkeeping: new EscalationBookkeeping(),
    warnedReasons: new Set<string>(),
  }
  core.arming.arm()
  // Production parity: the router observes via the shared runtime-state
  // singletons (apply() populates them; the rig mirrors that here).
  setRuntimeCore({ arming: core.arming, validation: { ok: true } })

  const classifyStates: string[] = []
  const injected: { text: string; source: unknown }[] = []
  const fetchImpl: typeof fetch = async (_url, init) => {
    if (options.failFetch !== undefined) throw options.failFetch
    classifyStates.push((JSON.parse(String(init?.body)) as { state: string }).state)
    return new Response(
      JSON.stringify({
        model: GAUGE_ROUTE.model,
        answers: { route: { type: 'choice', choice: 'draft', probabilities: options.probabilities ?? DRAFT_PROBABILITIES } },
        usage: { input_tokens: 100, output_tokens: 5 },
      }),
      { status: 200 },
    )
  }
  const deps: RouterDeps = {
    readSettings: () => ({ ...DEFAULT_MOA_SETTINGS, enabled: true }),
    routes: () => tierRoutes() as never,
    resolveBackend: () => ({ baseURL: 'http://127.0.0.1:9' }),
    fetchImpl,
  }
  const router = createRequestRouter(core, { validation: { ok: true }, deps })
  const payloads: { turn: number; step: number }[] = []

  const adapter = new MockAdapter(mainScript, REASONING)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('moa-router'), { provider: 'mock', model: 'mock' })

  // Registration mirror of apply() (D3.2 form). The ONLY remaining agent/request
  // listener is the payload counter — moa itself mounts none (classification
  // never re-enters the waterfall by construction now).
  agent.ctx.on('agent/inbox/claimed', ({ agent, message, turn }: { agent?: unknown; message: UserMessage; turn: number }) => {
    router.noteClaimed(agent, message, turn)
  })
  agent.ctx.on('agent/pre-step', router.preStepListener as never)
  agent.ctx.on('agent/request', async (payload: { turn: number; step: number }, next: RequestNext) => {
    payloads.push({ turn: payload.turn, step: payload.step })
    return next()
  })
  return { ctx, adapter, agent, wire: { core, router, classifyStates, injected, payloads } satisfies Wire }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** The driver contract (D3.2): classify BEFORE the followup. */
const runTurn = async (rig: Setup, text: string): Promise<void> => {
  const opening = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  await rig.wire.router.routeBeforeAdmission(rig.agent, opening)
  rig.agent.followup(opening)
  await rig.agent.whenIdle()
}

describe('moa router — promoted probe tests (real agent loop, D3.2)', () => {
  it('P1: the durable tier selection lands on EVERY step of a 2-step tool-call turn, with exactly ONE classify', async () => {
    const rig = await setup([toolCallResponse('c1', 'nonexistent_probe_tool', {}), textResponse('done')])
    await runTurn(rig, 'write a debounce function')

    // 2 model requests (tool step + final step); first dispatched request
    // carries step 1 (harness stores phase step 0 then dispatches step+1).
    expect(rig.adapter.requests).toHaveLength(2)
    expect(rig.wire.payloads.map((p) => p.step)).toEqual([1, 2])
    expect(rig.wire.classifyStates).toEqual(['write a debounce function']) // ONE classify (at admission)
    // The tier pair landed on EVERY step — the loop froze the same durable
    // selection at each preStep.
    for (const request of rig.adapter.requests) {
      expect(request).toMatchObject({ provider: 'mock', model: 'tier-draft' })
    }
  }, 30_000)

  it('P1b: the classify status row is injected (never silent) and the next admission classifies the genuine user text', async () => {
    const rig = await setup([textResponse('one'), textResponse('two')])
    await runTurn(rig, 'first prompt')
    await runTurn(rig, 'second prompt')
    // Status row present as a user/message with moa notice provenance (the
    // bind queued it at turn 1's claim; splice delivered it the same step).
    const rows = rig.agent.session.deriveMessages() as { source?: { kind?: string } }[]
    expect(rows.some((row) => row.source?.kind === 'moa')).toBe(true)
    // The classify input is the admitted user text, never the injected row:
    // grok r6 holds in the admission form (the admitted UserMessage IS the
    // classification input — no claimed-capture indirection, §4.2).
    expect(rig.wire.classifyStates).toEqual(['first prompt', 'second prompt'])
    expect(rig.adapter.requests.every((r) => r.model === 'tier-draft')).toBe(true)
  }, 30_000)

  it('P3a: no re-entry — agent/request firings equal the step count and the classify runs exactly once', async () => {
    const rig = await setup([textResponse('answer')])
    await runTurn(rig, 'go')
    expect(rig.wire.payloads).toHaveLength(1)
    expect(rig.wire.classifyStates).toHaveLength(1)
    expect(rig.adapter.requests).toHaveLength(1)
    expect(rig.adapter.requests[0]).toMatchObject({ model: 'tier-draft' })
  }, 30_000)

  it('P3b: System One failure (thrown fetch) degrades to the user/base pair; turn completes', async () => {
    const rig = await setup([textResponse('answer')], { failFetch: new Error('gateway down') })
    await runTurn(rig, 'go')
    expect(rig.wire.classifyStates).toHaveLength(0)
    expect(rig.wire.payloads).toHaveLength(1) // the request waterfall still fired
    expect(rig.adapter.requests).toHaveLength(1)
    expect(rig.adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'mock' }) // unchanged route
  }, 30_000)

  it('capture fixture: a claimed batch of [leading notice, escalation followup] restores the floor with NO classify (grok r6)', async () => {
    const rig = await setup([textResponse('retry answer')])
    // A retry turn opened via a typed moa-escalation followup with a queued
    // leading notice: the opening is the batch's LAST element. The judge's
    // pre-followup select is emulated (the retry MODEL is durable; F-3's
    // restore only feeds bookkeeping here).
    rig.agent.inject(noticeOpening('[queued] judge rejected the answer'))
    rig.agent.model.select({ provider: 'mock', model: 'tier-blueprint', reasoningEffort: ReasoningEffortId('max') })
    rig.wire.core.bookkeeping.recordFloor(1, 2)
    rig.agent.followup(escalationOpening('the first answer was rejected by the judge', 1, 1, 2))
    await rig.agent.whenIdle()
    // No classify; the durable escalation pair served; the floor bound.
    expect(rig.wire.classifyStates).toHaveLength(0)
    expect(rig.adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'tier-blueprint', reasoningEffort: ReasoningEffortId('max') })
    const { tierFor } = await import('../src/runtime-state.ts')
    expect(tierFor(1)).toBe(2)
  }, 30_000)
})
