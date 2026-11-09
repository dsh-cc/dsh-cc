/**
 * P-B ordering + truthful notices — the sanitizer's post-agent-creation
 * `{ prepend: true }` pre-step listener is OUTERMOST against the REAL harness
 * `installModelSelection` listeners (effective-model-truth design §6 P-B),
 * exercised on the real agent loop via the testkit (same pattern as
 * `router-probe.spec.ts`).
 *
 * Harness-0.2.2 semantics (D3.2): with moa routing at ADMISSION, moa's
 * select IS the step's frozen selection, so the harness's `[model changed]`
 * notice is TRUTHFUL BY CONSTRUCTION — pinned end-to-end here: a routed
 * tier switch produces zero notices while the pair is stable, and EXACTLY
 * one truthful notice when the frozen route changes, surviving the
 * sanitizer byte-identical (the phantom-drop rule is retired).
 *
 * The publish-before-observe order (sanitizer's outermost pre-step publish
 * preceding moa's pre-step observe) is pinned by recording what
 * `readPublishedSelection` reports when moa's observe listener runs: defined
 * and equal to the frozen pair ONLY if the sanitizer already published.
 * @module
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
import { createUserMessage, type LlmModelReasoningInfo, type UserMessage } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import { installModelSelectionSanitizer } from '../src/sanitizer.ts'
import { observeLiveSelection, readPublishedSelection, resetRuntimeCore, setRuntimeCore } from '../src/runtime-state.ts'
import { createRequestRouter, type RouterDeps } from '../src/router.ts'
import { ArmingMachine, DEFAULT_MOA_SETTINGS, EscalationBookkeeping, type MoaCore } from '../src/index.ts'
import { argmaxLabel, GAUGE_ROUTE, routes as tierRoutes } from './rig.ts'

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

const DRAFT_PROBABILITIES = { sketch: 0.05, draft: 0.7, blueprint: 0.15, masterplan: 0.1 }
const BLUEPRINT_PROBABILITIES = { sketch: 0.05, draft: 0.1, blueprint: 0.7, masterplan: 0.15 }

const BOOT = { provider: 'mock', model: 'mock' }

/**
 * Real agent loop + REAL harness `installModelSelection` (1-arg) + the
 * sanitizer, with moa's production listener shape mirrored exactly as
 * `apply` mounts it (observe-published-selection pre-step listener first,
 * then the router's row splice; claimed bind at the inbox listener). The
 * admission seam is driven by runTurn below, exactly like the driver.
 */
async function setup(options: { script?: Script; sanitizer?: boolean } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-moa-sanitizer-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(options.script ?? [toolCallResponse('c1', 'nonexistent_probe_tool', {}), textResponse('done')], REASONING)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('moa-sanitizer'), { provider: 'mock', model: 'mock' })

  const core: MoaCore = {
    arming: new ArmingMachine(() => true),
    bookkeeping: new EscalationBookkeeping(),
    warnedReasons: new Set<string>(),
  }
  core.arming.arm()
  setRuntimeCore({ arming: core.arming, validation: { ok: true } })

  /** What the sanitizer had published when moa's pre-step observe ran. */
  const publishedAtObserve: ReturnType<typeof readPublishedSelection>[] = []
  // Mirror of apply()'s FIRST moa pre-step listener (index.ts observePreStep):
  // tripwire-observe the sanitizer's published frozen selection, then feed
  // the row splice.
  const observePreStep = async (payload: { agent?: unknown }, next: () => Promise<unknown>): Promise<unknown> => {
    publishedAtObserve.push(readPublishedSelection(payload.agent))
    const live = readPublishedSelection(payload.agent)
    if (live?.model !== undefined) observeLiveSelection(live)
    return router.preStepListener(payload as never, next)
  }
  let probabilities = DRAFT_PROBABILITIES
  const classifyStates: string[] = []
  const fetchImpl: typeof fetch = async (_url, init) => {
    classifyStates.push((JSON.parse(String(init?.body)) as { state: string }).state)
    return new Response(
      JSON.stringify({
        model: GAUGE_ROUTE.model,
        answers: { route: { type: 'choice', choice: argmaxLabel(probabilities), probabilities } },
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

  // Registration order mirrors production (D3.2 form): moa's claimed bind +
  // pre-step observe/splice listeners; the harness's installModelSelection
  // notice listener; the sanitizer co-located AFTER it, later-with-prepend →
  // outermost pre-step listener. The retired seams (agent/request overlay,
  // system-prompt/assemble classification) are gone.
  agent.ctx.on('agent/inbox/claimed', ({ agent, message, turn }: { agent?: unknown; message: UserMessage; turn: number }) => {
    router.noteClaimed(agent, message, turn)
  })
  agent.ctx.on('agent/pre-step', observePreStep as never)
  installModelSelection(agent.ctx)
  if (options.sanitizer !== false) installModelSelectionSanitizer(agent.ctx)
  return {
    adapter,
    agent,
    router,
    classifyStates,
    publishedAtObserve,
    /** Swap the System One argmax for the next admission. */
    setProbabilities: (next: Record<string, number>) => {
      probabilities = next
    },
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** The driver contract (D3.2): classify BEFORE the followup. */
const runTurn = async (rig: Setup, text: string): Promise<void> => {
  const opening = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  await rig.router.routeBeforeAdmission(rig.agent, opening)
  rig.agent.followup(opening)
  await rig.agent.whenIdle()
}

describe('P-B: sanitizer ordering + truthful notices against the real harness listeners (real agent loop)', () => {
  it('a stable routed pair produces ZERO model-selection notices; a tier change produces ONE truthful notice, dropped nowhere (sanitizer passthrough)', async () => {
    const rig = await setup({ script: [textResponse('one'), textResponse('two')] })
    await runTurn(rig, 'write a debounce function')
    // Turn 1: durable tier-draft from admission onward — header == frozen on
    // every step (no phantom exists: prior header undefined at step 1).
    expect(rig.adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'tier-draft' })
    // Turn 2 classifies to blueprint: the frozen route CHANGES vs the last
    // request header → the harness appends its notice — TRUTHFUL (the wire
    // really serves blueprint from here).
    rig.setProbabilities(BLUEPRINT_PROBABILITIES)
    await runTurn(rig, 'redesign the module')
    expect(rig.adapter.requests[1]).toMatchObject({ provider: 'mock', model: 'tier-blueprint' })
    const rows = (rig.agent.session.deriveMessages() as { source?: { kind?: string } }[]).filter(
      (m) => m.source?.kind === 'model-selection',
    )
    expect(rows).toHaveLength(1)
    expect(rig.classifyStates).toHaveLength(2)
    // The notice survived the sanitizer (passthrough-by-design): control —
    // with the sanitizer REMOVED the count is identical, because the drop
    // rule is retired (notices are truthful under pre-admission routing).
    const control = await setup({ script: [textResponse('one'), textResponse('two')], sanitizer: false })
    await runTurn(control, 'write a debounce function')
    control.setProbabilities(BLUEPRINT_PROBABILITIES)
    await runTurn(control, 'redesign the module')
    const controlRows = (control.agent.session.deriveMessages() as { source?: { kind?: string } }[]).filter(
      (m) => m.source?.kind === 'model-selection',
    )
    expect(controlRows).toHaveLength(rows.length)
  }, 30_000)

  it('spy order: the sanitizer publish is recorded BEFORE moa’s pre-step observe (the frozen pair is already published when the observe listener runs)', async () => {
    const rig = await setup({ script: [textResponse('done')] })
    await runTurn(rig, 'go')
    // Every root pre-step saw the frozen pair already published — only
    // possible if the sanitizer's outermost listener ran first. Turn 1's
    // frozen pair is the ROUTED tier (admission selected it pre-step), and
    // the tripwire accepts it as moa's own write (it matches
    // noteMoaSelection from admission).
    expect(rig.publishedAtObserve.length).toBeGreaterThanOrEqual(1)
    expect(rig.publishedAtObserve.every((p) => p !== undefined && p.model === 'tier-draft' && p.provider === 'mock')).toBe(true)
  }, 30_000)
})
