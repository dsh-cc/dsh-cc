/**
 * Acceptance judge + escalation tests — INTEGRATION layer (real agent loop +
 * MockAdapter + session persistence, design §3.4/§3.5, §8 rows):
 * idle-wake retry (verdict after the loop settles idle), retry identity (no
 * re-classify, retriesUsed increments), single-row presentation, the
 * deriveMessages continuation fixture, and the executed-ceiling skip.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonl } from '@dsh-cc/sidecar-io'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage, type LlmCallConfig, type LlmModelReasoningInfo, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import { createOpeningCapture } from '../src/capture.ts'
import { createAcceptanceJudge, type JudgeDeps } from '../src/judge.ts'
import { createRequestRouter, type ArmingValidation, type RequestRouter, type RouterDeps } from '../src/router.ts'
import { ArmingMachine, EscalationBookkeeping, type MoaCore, type MoaSettings } from '../src/index.ts'
import { routes as tierRoutes, GAUGE_ROUTE } from './rig.ts'

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

const ROUTE_PROBABILITIES = { sketch: 0.05, draft: 0.7, blueprint: 0.15, masterplan: 0.1 }

interface LoopRig {
  core: MoaCore
  router: RequestRouter
  agent: Agent
  adapter: MockAdapter
  classifyStates: string[]
  acceptStates: string[]
  routingLedger: string
  acceptanceLedger: string
  /** Resolve a held judge call (undefined when nothing is held). */
  release: () => void
}

interface LoopOptions {
  acceptanceEnabled?: boolean
  shadow?: boolean
  maxEscalations?: number
  pAccept?: number
  /** Hold the first judge call until `release()` (idle-wake timing). */
  holdJudge?: boolean
}

async function setupLoop(mainScript: Script, options: LoopOptions = {}): Promise<LoopRig> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-moa-judge-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(mainScript, REASONING)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('moa-judge'), { provider: 'mock', model: 'mock' })

  const settings: MoaSettings = {
    enabled: true,
    acceptance: {
      enabled: options.acceptanceEnabled ?? true,
      shadow: options.shadow ?? false,
      tau: 0.7,
    },
    maxEscalations: options.maxEscalations ?? 1,
    judgeRoute: undefined,
    classifyBudgetTokens: 4000,
    callBudgetMs: 8000,
  }
  const arming = new ArmingMachine(() => settings.enabled)
  arming.arm()
  const bookkeeping = new EscalationBookkeeping()
  const core: MoaCore = { readSettings: () => settings, arming, bookkeeping }

  const capture = createOpeningCapture()
  const validation: ArmingValidation = { ok: true }
  agent.ctx.on('agent/pre-step', capture.listener as never)

  const classifyStates: string[] = []
  const acceptStates: string[] = []
  let heldJudge: { release: () => void } | undefined
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown>; state: string }
    if (!('accept' in body.questions)) {
      classifyStates.push(body.state)
      return new Response(
        JSON.stringify({
          model: GAUGE_ROUTE.model,
          answers: { route: { type: 'choice', choice: 'draft', probabilities: ROUTE_PROBABILITIES } },
          usage: { input_tokens: 100, output_tokens: 5 },
        }),
        { status: 200 },
      )
    }
    acceptStates.push(body.state)
    if (options.holdJudge === true && heldJudge === undefined) {
      let release!: () => void
      const promise = new Promise<void>((r) => (release = r))
      heldJudge = { release: () => release() }
      await promise
    }
    const p = options.pAccept ?? 0.2
    return new Response(
      JSON.stringify({
        model: GAUGE_ROUTE.model,
        answers: { accept: { type: 'choice', choice: 'acceptable', probabilities: { acceptable: p, unacceptable: 1 - p } } },
        usage: { input_tokens: 100, output_tokens: 5 },
      }),
      { status: 200 },
    )
  }
  const routerDeps: RouterDeps = {
    getCapturedOpening: capture.getCapturedOpening,
    routes: () => tierRoutes() as never,
    resolveBackend: () => ({ baseURL: 'http://127.0.0.1:9' }),
    fetchImpl,
  }
  const router = createRequestRouter(core, { validation, deps: routerDeps })
  agent.ctx.on('agent/pre-step', router.preStepListener as never)
  agent.ctx.on('agent/request', router.listener as never)

  const judgeDeps: JudgeDeps = {
    getCapturedOpening: capture.getCapturedOpening,
    tierFor: (turnId) => router.tierFor(turnId),
    routes: () => tierRoutes() as never,
    resolveBackend: () => ({ baseURL: 'http://127.0.0.1:9' }),
    fetchImpl,
    routingLedgerPath: () => join(root, 'moa', 'routing.jsonl'),
    acceptanceLedgerPath: () => join(root, 'moa', 'acceptance.jsonl'),
  }
  const judge = createAcceptanceJudge(core, { validation, deps: judgeDeps })
  agent.ctx.on('agent/turn-stopping', judge.listener as never)

  return {
    core,
    router,
    agent,
    adapter,
    classifyStates,
    acceptStates,
    routingLedger: join(root, 'moa', 'routing.jsonl'),
    acceptanceLedger: join(root, 'moa', 'acceptance.jsonl'),
    release: () => heldJudge?.release(),
  }
}

const runTurn = async (agent: Agent, text: string, source: Record<string, unknown> = { kind: 'user' }): Promise<void> => {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source } as never))
  await agent.whenIdle()
}

/** Poll until `predicate` holds (detached judge pipeline timing). */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (!predicate()) throw new Error(`waitFor timed out: ${what}`)
}

interface DerivedRow {
  source?: { kind?: string; originSeq?: number; fromTier?: number; toTier?: number; summary?: string }
}

describe('moa acceptance judge — integration (real agent loop)', () => {
  it('idle-wake: verdict after the loop settles idle still produces the retry turn at the higher tier (grok r3)', async () => {
    const rig = await setupLoop([textResponse('first answer'), textResponse('retry answer')], { holdJudge: true })
    await runTurn(rig.agent, 'write a debounce function')
    // The loop is idle and the judge verdict is still in flight — no retry yet.
    expect(rig.adapter.requests).toHaveLength(1)

    rig.release()
    await waitFor(() => rig.adapter.requests.length >= 2, 'retry turn request')
    await rig.agent.whenIdle() // followup wakes the settled idle loop
    // Retry turn ran at the escalated tier (draft → blueprint), with NO
    // second classify (a re-classify would make escalation a no-op).
    expect(rig.adapter.requests).toHaveLength(2)
    expect(rig.adapter.requests[1]).toMatchObject({ provider: 'mock', model: 'tier-blueprint' })
    expect(rig.classifyStates).toEqual(['write a debounce function'])
    expect(rig.acceptStates).toHaveLength(1)
    // Retry identity + counter (origin seq is the opening user/message event
    // seq — read it back from the escalate ledger row).
    const escalated = (await pollJsonl<{ type: string; originSeq: number }>(rig.routingLedger, 1))[0]
    expect(rig.core.bookkeeping.stateFor(escalated.originSeq)).toMatchObject({ tierFloor: 2, retriesUsed: 1 })
  }, 30_000)

  it('single row + deriveMessages continuation: the typed followup IS the escalation status row', async () => {
    const rig = await setupLoop([textResponse('first answer'), textResponse('retry answer')])
    await runTurn(rig.agent, 'write a debounce function')
    await runTurn(rig.agent, 'ignore-me', { kind: 'user' }) // settle any pending wake
    const derived = rig.agent.session.deriveMessages() as (DerivedRow & { content?: { type: string; text?: string }[] })[]
    const escalations = derived.filter((row) => row.source?.kind === 'moa-escalation')
    expect(escalations).toHaveLength(1) // exactly ONE visible escalation row
    const source = escalations[0].source as { originSeq?: number; fromTier?: number; toTier?: number; summary?: string }
    expect(source.fromTier).toBe(1)
    expect(source.toTier).toBe(2)
    expect(source.summary).toBe('moa: draft → blueprint, first answer rejected by judge')
    // Continuation, not an ambiguous fresh user utterance: the derived
    // history is [system, user request, first answer, typed followup] in
    // order (advisor array-assertion fix, §8).
    const texts = derived.map((row) => (row.content ?? []).map((b) => b.text ?? '').join(''))
    const requestIndex = texts.findIndex((text) => text.includes('write a debounce function'))
    const answerIndex = texts.findIndex((text) => text.includes('first answer'))
    const followupIndex = texts.findIndex((text) => text.includes('first answer rejected by judge'))
    expect(requestIndex).toBeGreaterThan(-1)
    expect(answerIndex).toBeGreaterThan(requestIndex)
    expect(followupIndex).toBeGreaterThan(answerIndex)
    // Ledger rows: judge verdict (acted) + routing escalate row.
    const judgeRows = await pollJsonl<{ type: string; acted: boolean; pAcceptable: number; eligible: boolean }>(rig.acceptanceLedger, 1)
    expect(judgeRows[0]).toMatchObject({ type: 'judge', acted: true, pAcceptable: 0.2, eligible: true })
    const escalateRows = await readJsonl<{ type: string; fromTier: number; toTier: number }>(rig.routingLedger)
    expect(escalateRows[0]).toMatchObject({ type: 'escalate', fromTier: 1, toTier: 2 })
  }, 30_000)

  it('eligibility: a turn WITH tool calls → no judge call, no retry (§3.4 gate)', async () => {
    const rig = await setupLoop([toolCallResponse('c1', 'nonexistent_probe_tool', {}), textResponse('done')])
    await runTurn(rig.agent, 'edit the files')
    expect(rig.classifyStates).toEqual(['edit the files'])
    expect(rig.acceptStates).toHaveLength(0)
    expect(rig.adapter.requests.every((r) => r.model === 'tier-draft')).toBe(true)
  }, 30_000)

  it('ceiling: after one executed escalation the judge is not called again for that origin (retriesUsed == max)', async () => {
    const rig = await setupLoop(
      [textResponse('first answer'), textResponse('retry answer')],
      { maxEscalations: 1 },
    )
    await runTurn(rig.agent, 'write a debounce function') // turn 1 → escalated
    await waitFor(() => rig.acceptStates.length >= 1, 'first judge call')
    await runTurn(rig.agent, 'next', { kind: 'user' }) // retry turn ran (turn 2)
    await new Promise((resolve) => setTimeout(resolve, 50)) // settle the retry turn's judge gate
    expect(rig.acceptStates).toHaveLength(1)
    const escalated = (await pollJsonl<{ type: string; originSeq: number }>(rig.routingLedger, 1))[0]
    expect(rig.core.bookkeeping.stateFor(escalated.originSeq)).toMatchObject({ tierFloor: 2, retriesUsed: 1 })
  }, 30_000)

  it('shadow: judge called on tool turns too, verdict logged eligible:false, no followup', async () => {
    const rig = await setupLoop([toolCallResponse('c1', 'nonexistent_probe_tool', {}), textResponse('done')], {
      acceptanceEnabled: false,
      shadow: true,
    })
    await runTurn(rig.agent, 'edit the files')
    expect(rig.classifyStates).toEqual(['edit the files'])
    await waitFor(() => rig.acceptStates.length >= 1, 'shadow judge call')
    const judgeRows = await pollJsonl<{ eligible: boolean; acted: boolean; shadow: boolean }>(rig.acceptanceLedger, 1)
    expect(judgeRows[0]).toMatchObject({ eligible: false, acted: false, shadow: true })
  }, 30_000)
})

/** Poll a JSONL ledger until it has `count` rows (async fs write race). */
async function pollJsonl<T>(path: string, count: number): Promise<T[]> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const rows = await readJsonl<T>(path)
    if (rows.length >= count) return rows
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return readJsonl<T>(path)
}

// keep the UserMessage import referenced (fixture typing)
void (null as unknown as UserMessage | undefined)
