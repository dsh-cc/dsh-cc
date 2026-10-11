/**
 * Promoted live-probe tests (design §8): P1 (multi-step override lands on
 * EVERY step of a 2-step tool-call turn), P3a (no re-entry: agent/request
 * firings == step count, exactly ONE classify call), P3b (System One
 * failure → fail-open pass-through), plus the grok r5/r6 capture fixture
 * (claimed batch = [leading notice, opening message]; classify input is the
 * pre-step capture's LAST element, i.e. the CURRENT turn's text).
 *
 * Driven against the real agent loop + MockAdapter (probe seam). The System
 * One judge lane is `fetchImpl`-mocked: §3.6 — System One consumers use their
 * own protocol client and never reach the llm adapter waterfall.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage, type LlmCallConfig, type LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import { createOpeningCapture } from '../src/capture.ts'
import { createRequestRouter, textOf, type RouterDeps } from '../src/router.ts'
import { ArmingMachine, DEFAULT_MOA_SETTINGS, EscalationBookkeeping, type MoaCore } from '../src/index.ts'
import { GAUGE_ROUTE, noticeOpening, routes as tierRoutes, userOpening } from './rig.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const REASONING = {
  efforts: [
    { id: 'low', name: 'low' },
    { id: 'max', name: 'max' },
  ],
} as unknown as LlmModelReasoningInfo

type Script = ConstructorParameters<typeof MockAdapter>[0]
type RequestPayload = { agent: Agent; turn: number; step: number; signal: AbortSignal }
type RequestNext = () => Promise<LlmCallConfig>

const DRAFT_PROBABILITIES = { sketch: 0.05, draft: 0.7, blueprint: 0.15, masterplan: 0.1 }

interface Wire {
  core: MoaCore
  capture: ReturnType<typeof createOpeningCapture>
  classifyStates: string[]
  injected: { text: string; source: unknown }[]
  payloads: { turn: number; step: number }[]
}

/**
 * Wire the production capture + router listeners onto the agent loop exactly
 * as `apply` does, with fake seams (fake ModelRoutes + canned System One).
 */
async function setup(mainScript: Script, options: { probabilities?: Record<string, number>; failFetch?: Error } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-moa-router-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(mainScript, REASONING)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('moa-router'), { provider: 'mock', model: 'mock' })

  const core: MoaCore = {
    readSettings: () => ({ ...DEFAULT_MOA_SETTINGS, enabled: true }),
    arming: new ArmingMachine(() => true),
    bookkeeping: new EscalationBookkeeping(),
  }
  core.arming.arm()
  const capture = createOpeningCapture()
  agent.ctx.on('agent/pre-step', capture.listener as never)

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
    getCapturedOpening: capture.getCapturedOpening,
    routes: () => tierRoutes() as never,
    resolveBackend: () => ({ baseURL: 'http://127.0.0.1:9' }),
    fetchImpl,
  }
  const router = createRequestRouter(core, { validation: { ok: true }, deps })
  agent.ctx.on('agent/pre-step', router.preStepListener as never)
  const payloads: { turn: number; step: number }[] = []
  agent.ctx.on('agent/request', async (payload: RequestPayload, next: RequestNext) => {
    payloads.push({ turn: payload.turn, step: payload.step })
    return next()
  })
  agent.ctx.on('agent/request', router.listener as never)
  return { ctx, adapter, agent, wire: { core, capture, classifyStates, injected, payloads } satisfies Wire }
}

const runTurn = async (agent: Awaited<ReturnType<typeof setup>>['agent'], text: string): Promise<void> => {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

describe('moa router — promoted probe tests (real agent loop)', () => {
  it('P1: the classify override lands on EVERY step of a 2-step tool-call turn, with exactly ONE classify', async () => {
    const { adapter, agent, wire } = await setup([toolCallResponse('c1', 'nonexistent_probe_tool', {}), textResponse('done')])
    await runTurn(agent, 'write a debounce function')

    // 2 model requests (tool step + final step); first dispatched request
    // carries step 1 (harness stores phase step 0 then dispatches step+1).
    expect(adapter.requests).toHaveLength(2)
    expect(wire.payloads.map((p) => p.step)).toEqual([1, 2])
    expect(wire.classifyStates).toEqual(['write a debounce function']) // ONE classify
    // Override landed on EVERY step.
    for (const request of adapter.requests) {
      expect(request).toMatchObject({ provider: 'mock', model: 'tier-draft' })
    }
  }, 30_000)

  it('P1b: the classify status row is injected (never silent) and lands in history as a leading notice next turn', async () => {
    const { adapter, agent, wire } = await setup([textResponse('one'), textResponse('two')])
    await runTurn(agent, 'first prompt')
    // The queued inject is delivered when the loop claims its next batch.
    await runTurn(agent, 'second prompt')
    // Status row present as a user/message with moa notice provenance.
    const rows = agent.session.deriveMessages() as { source?: { kind?: string } }[]
    expect(rows.some((row) => row.source?.kind === 'moa')).toBe(true)
    // grok r6: turn 2's claimed batch = [moa notice, 'second prompt'] — the
    // classify input is the LAST element (the genuine user text), never the
    // notice, and never session history.
    expect(wire.classifyStates).toEqual(['first prompt', 'second prompt'])
    expect(adapter.requests.every((r) => r.model === 'tier-draft')).toBe(true)
  }, 30_000)

  it('P3a: no re-entry — agent/request firings equal the step count and the classify runs exactly once', async () => {
    const { adapter, agent, wire } = await setup([textResponse('answer')])
    let agentRequestCount = 0
    // (payloads captured inside setup already count firings)
    await runTurn(agent, 'go')
    agentRequestCount = wire.payloads.length
    expect(agentRequestCount).toBe(1)
    expect(wire.classifyStates).toHaveLength(1)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ model: 'tier-draft' })
  }, 30_000)

  it('P3b: System One failure (thrown fetch) degrades to the unmodified resolved route; turn completes', async () => {
    const { adapter, agent, wire } = await setup([textResponse('answer')], { failFetch: new Error('gateway down') })
    await runTurn(agent, 'go')
    expect(wire.classifyStates).toHaveLength(0)
    expect(wire.payloads).toHaveLength(1) // the request waterfall still fired
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'mock' }) // unchanged route
  }, 30_000)

  it('capture fixture: a claimed batch of [leading notice, escalation followup] exposes the LAST element as the opening (grok r6)', async () => {
    const { adapter, agent, wire } = await setup([textResponse('retry answer')])
    // A retry turn opened via a typed moa-escalation followup with a queued
    // leading notice: the opening is the batch's LAST element.
    agent.inject(noticeOpening('[queued] judge rejected the answer'))
    wire.core.bookkeeping.recordFloor(1, 2)
    agent.followup(escalationFollowup())
    await agent.whenIdle()
    // The escalation floor (blueprint, index 2) applied without classify.
    expect(wire.classifyStates).toHaveLength(0)
    expect(adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'tier-blueprint' })
  }, 30_000)
})

/** Typed moa-escalation followup for origin seq 1 (fromTier draft → blueprint). */
function escalationFollowup() {
  return createUserMessage({
    content: [{ type: 'text', text: 'the first answer was rejected by the judge' }],
    source: { kind: 'moa-escalation', originSeq: 1, fromTier: 1, toTier: 2 },
  })
}

// keep textOf referenced for the mechanism spec import symmetry
void textOf
void userOpening
