/**
 * P-B ordering — the sanitizer's post-agent-creation `{ prepend: true }`
 * pre-step listener is OUTERMOST against the REAL harness
 * `installModelSelection` listeners (effective-model-truth design §6 P-B),
 * exercised on the real agent loop via the testkit (same pattern as
 * `router-probe.spec.ts`).
 *
 * Pinned at the END-TO-END RUNTIME level (not registration internals):
 * with moa armed and overlaying the boot selection (probe: every request is
 * rewritten to the draft tier, so the session header diverges from the frozen
 * `selection.assembled` — the exact live-evidence shape of §2), the harness
 * notice listener DOES append `source.kind === 'model-selection'` rows (the
 * no-sanitizer control proves it), yet the pre-step decision messages that
 * flow back through the sanitizer — i.e. what the loop admits — contain ZERO
 * such rows.
 *
 * The publish-before-observe order (sanitizer's outermost pre-step publish
 * preceding moa's pre-step observe) is pinned by recording what
 * `readPublishedSelection` reports when moa's observe listener runs: defined
 * and equal to the frozen boot pair ONLY if the sanitizer already published.
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
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage, type LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import { installModelSelectionSanitizer } from '../src/sanitizer.ts'
import { captureClaimed, getCapturedOpening, noteClaimedTurn, observeLiveSelection, readPublishedSelection, resetRuntimeCore, setRuntimeCore } from '../src/runtime-state.ts'
import { createRequestRouter, type RouterDeps } from '../src/router.ts'
import { ArmingMachine, DEFAULT_MOA_SETTINGS, EscalationBookkeeping, type MoaCore } from '../src/index.ts'
import { GAUGE_ROUTE, routes as tierRoutes } from './rig.ts'

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

const BOOT = { provider: 'mock', model: 'mock' }

/**
 * Real agent loop + REAL harness `installModelSelection` + the sanitizer,
 * with moa's production listener shape mirrored exactly as `apply` mounts it
 * (observe-published-selection pre-step listener first, then the router).
 */
async function setup(options: { sanitizer?: boolean; script?: Script } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-moa-sanitizer-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(options.script ?? [toolCallResponse('c1', 'nonexistent_probe_tool', {}), textResponse('done')], REASONING)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('moa-sanitizer'), { provider: 'mock', model: 'mock' })

  const selection: ModelSelectionRef = { current: { ...BOOT }, assembled: undefined }
  const core: MoaCore = {
    readSettings: () => ({ ...DEFAULT_MOA_SETTINGS, enabled: true }),
    arming: new ArmingMachine(() => true),
    bookkeeping: new EscalationBookkeeping(),
  }
  core.arming.arm()
  setRuntimeCore({ arming: core.arming, validation: { ok: true } })

  const capture: { getCapturedOpening: (turnId: number) => unknown } = { getCapturedOpening }
  /** What the sanitizer had published when moa's pre-step observe ran. */
  const publishedAtObserve: ReturnType<typeof readPublishedSelection>[] = []
  // Mirror of apply()'s FIRST moa pre-step listener (index.ts observePreStep):
  // read the sanitizer's published frozen selection, then feed the splice.
  const observePreStep = async (payload: { agent?: unknown }, next: () => Promise<unknown>): Promise<unknown> => {
    publishedAtObserve.push(readPublishedSelection(payload.agent))
    const live = readPublishedSelection(payload.agent)
    if (live?.model !== undefined) observeLiveSelection(live)
    return router.preStepListener(payload as never, next)
  }
  // Mirror of apply()'s `agent/inbox/claimed` capture listener (§5.3).
  const claimedListener = ({ agent, message, turn }: { agent?: unknown; message: never; turn: number }): void => {
    captureClaimed(agent, message, turn)
    noteClaimedTurn(agent, turn)
  }
  const classifyStates: string[] = []
  const fetchImpl: typeof fetch = async (_url, init) => {
    classifyStates.push((JSON.parse(String(init?.body)) as { state: string }).state)
    return new Response(
      JSON.stringify({
        model: GAUGE_ROUTE.model,
        answers: { route: { type: 'choice', choice: 'draft', probabilities: DRAFT_PROBABILITIES } },
        usage: { input_tokens: 100, output_tokens: 5 },
      }),
      { status: 200 },
    )
  }
  const deps: RouterDeps = {
    routes: () => tierRoutes() as never,
    resolveBackend: () => ({ baseURL: 'http://127.0.0.1:9' }),
    fetchImpl,
  }
  const router = createRequestRouter(core, { validation: { ok: true }, deps })

  // Registration order mirrors production: moa's agent/request listener is
  // OUTER relative to the harness's request listener (apply t0 < agent
  // creation t1); the sanitizer is installed co-located AFTER
  // installModelSelection, later-with-prepend → outermost pre-step listener.
  // The assemble seam follows the same rule: moa's assemble listener registers
  // BEFORE installModelSelection → OUTER → it reads the harness-written
  // selection variables after `await next()` (§5.3).
  agent.ctx.on('agent/inbox/claimed', claimedListener as never)
  agent.ctx.on('agent/pre-step', observePreStep as never)
  agent.ctx.on('agent/request', router.listener as never)
  agent.ctx.on('system-prompt/assemble', router.assembleListener as never)
  installModelSelection(agent.ctx, selection)
  if (options.sanitizer !== false) installModelSelectionSanitizer(agent.ctx, selection as never)
  return { adapter, agent, classifyStates, publishedAtObserve }
}

const runTurn = async (agent: Awaited<ReturnType<typeof setup>>['agent'], text: string): Promise<void> => {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

describe('P-B: sanitizer ordering against the real harness listeners (real agent loop)', () => {
  it('end-to-end: under an armed overlay on the boot selection, ZERO model-selection rows survive, while the no-sanitizer control shows the harness DOES append them', async () => {
    // Control first: identical rig WITHOUT the sanitizer — the harness notice
    // listener fires at step 2 (header = tier-draft ≠ assembled = boot) and
    // its phantom row reaches the transcript.
    const control = await setup({ sanitizer: false })
    await runTurn(control.agent, 'write a debounce function')
    const controlRows = (control.agent.session.deriveMessages() as { source?: { kind?: string } }[]).filter(
      (m) => m.source?.kind === 'model-selection',
    )
    expect(controlRows.length, 'control: harness appended phantom model-selection notices').toBeGreaterThanOrEqual(1)
    // The overlay really was active on every step (the drop rule's premise).
    expect(control.adapter.requests).toHaveLength(2)
    for (const request of control.adapter.requests) expect(request).toMatchObject({ provider: 'mock', model: 'tier-draft' })

    // With the sanitizer: same rig, phantom rows are gone end-to-end.
    const { agent } = await setup()
    await runTurn(agent, 'write a debounce function')
    const rows = (agent.session.deriveMessages() as { source?: { kind?: string } }[]).filter(
      (m) => m.source?.kind === 'model-selection',
    )
    expect(rows).toEqual([])
  }, 30_000)

  it('spy order: the sanitizer publish is recorded BEFORE moa’s pre-step observe (the frozen boot pair is already published when the observe listener runs)', async () => {
    const { agent, publishedAtObserve } = await setup({ script: [textResponse('done')] })
    await runTurn(agent, 'go')
    // Every root pre-step saw the frozen boot pair already published — only
    // possible if the sanitizer's outermost listener ran first.
    expect(publishedAtObserve.length).toBeGreaterThanOrEqual(1)
    expect(publishedAtObserve.every((p) => p !== undefined && p.model === BOOT.model && p.provider === BOOT.provider)).toBe(true)
  }, 30_000)
})
