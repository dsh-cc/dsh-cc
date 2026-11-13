/**
 * Integration specs (design
 * docs/plans/2026-11-12-compaction-governed-pinning.md §Verification /
 * Integration): the plugin driven by the REAL compaction engine against the
 * REAL session log backend.
 *
 * Composition: `mountAgentLoopTestDependencies` (real LlmRuntime, SessionStore,
 * projection registry, agent registry) + REAL `JsonlSessionPersistence` into a
 * temp root + REAL harness `BasicCompactionEngine` (`@deepseek-ai/dsh-compaction-basic`,
 * `auto: true` so its own `agent/pre-step` / `agent/request` /
 * `agent/request-error` listeners are the production ones) + the plugin under
 * test. Only the LLM is faked: one scripted `LlmAdapter` answers both the
 * conversation request and the engine's `purpose: 'compaction'` call, exactly
 * as the harness's own compaction specs do. Span selection, summarization
 * planning, the checkpoint `replace` commit, the lifecycle events, and every
 * append validation are the real ones — so a restore that the real session
 * validator would reject fails here.
 *
 * Per-source restore timing (§Restore timing) is what each case pins:
 *
 * - harness pressure auto — the engine compacts INSIDE the pre-step; the
 *   delegate-first `{ prepend: true }` drain restores in that SAME pre-step
 *   (no model-visible exposure);
 * - manual `/compact` and cost-gate idle — idle compaction, restore lands on
 *   the NEXT pre-step (the pin is genuinely absent from the surface between);
 * - in-request overflow / model-switch — the retry continuation's derivation
 *   can LACK the pin (the accepted one-request gap is real and bounded); the
 *   next pre-step restores it.
 *
 * @module
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmAdapter, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { textResponse } from '@dsh-cc/agent-loop-mock'
import * as Plugin from '../src/index.ts'
import { derivedUserTexts, governanceMessage, publish, rigSettings, runPreStep } from './rig.ts'

beforeEach(() => {
  Plugin.resetPinningHealth()
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** The governance pin under test. */
const RULE = 'Always run the focused test before claiming a fix.'

/** The mock summarizer's output (distinctive so the checkpoint is greppable). */
const SUMMARY_TEXT = 'condensed by the scripted mock summarizer'

/** A user message large enough that two of them cross the priced threshold. */
const NOISE = 'noise '.repeat(400)

/**
 * Scripted adapter: the only fake in this file. `resolveModel` reports a
 * context window (the pressure path prices the routed model's capacity) and
 * `stream` answers the conversation and the summarization call identically.
 */
class ScriptedAdapter extends LlmAdapter {
  /** Every request handed to the adapter, in order. */
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly contextWindow: number,
    private readonly summaryText: string = SUMMARY_TEXT,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: this.contextWindow } })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield* textResponse(options.purpose === 'compaction' ? this.summaryText : 'ok')
  }
}

/** The live integration rig: real persistence + real engine + plugin. */
interface IntegrationRig {
  ctx: Context
  agent: Agent
  engine: BasicCompactionEngine
  /** The routed (`mock`) adapter: conversation and compaction calls. */
  adapter: ScriptedAdapter
  seen: SessionEvent[]
  states: Plugin.PinningStateRegistry
  settings: Plugin.CompactionPinningSettings
  root: string
}

/**
 * Build the rig.
 * @param options.contextWindow - the routed model's capacity (default 1000).
 * @returns the live rig.
 */
async function integrationRig(options: { contextWindow?: number } = {}): Promise<IntegrationRig> {
  const settings = rigSettings()
  const root = mkdtempSync(join(tmpdir(), 'cp-integration-'))
  roots.push(root)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  // REAL durability: one plain-text JSONL generation per session under `root`.
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  new TokenMeter(ctx)
  const adapter = new ScriptedAdapter(options.contextWindow ?? 1_000)
  ctx.llm.registerAdapter(['mock'], adapter)
  // The switch target: a smaller window (400 → threshold 200) so the history
  // must be compacted before the request can be built.
  ctx.llm.registerAdapter(['tiny'], new ScriptedAdapter(400))
  const seen: SessionEvent[] = []
  ctx.on('session/event', (_session: unknown, event: SessionEvent) => { seen.push(event) }, { global: true })
  const states = Plugin.createPinningStateRegistry(() => settings)
  await ctx.plugin(Plugin, { readSettings: () => settings, states })
  const agent = await ctx.agentLoop.create(SessionId('cp-integration'), { provider: 'mock', model: 'mock' })
  // The production engine, whole: `auto: true` mounts its own pressure,
  // model-switch, and overflow listeners. `retainTokens: 0` keeps only the last
  // surface node so the compacted span always covers the pin and the surface
  // lands below threshold. `thresholdRatio: 0.5` of the 1000-token window (500)
  // sits between two NOISE messages (~600 tokens each).
  const engine = new BasicCompactionEngine(ctx, {
    auto: true,
    headroomTokens: 0,
    maxTokens: 32,
    thresholdRatio: 0.5,
    retainTokens: 0,
  })
  return { ctx, agent, engine, adapter, seen, states, settings, root }
}

/**
 * Append one closed turn the way the loop records it: prompt, routed header,
 * one small assistant reply. The tiny assistant reply is the surface's last
 * node, i.e. the retained tail.
 * @param session - the session to seed.
 * @param turn - the turn number.
 * @param prompts - user prompts for that turn (surface nodes).
 */
function seedTurn(session: Session, turn: number, prompts: string[]): void {
  session.append('turn/start', { turn })
  for (const prompt of prompts) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  session.append('step/start', { turn, step: 1 })
  session.append('request/header', {
    header: { config: { provider: 'mock', model: 'mock' } },
    reason: turn === 1 ? 'initial' : 'change',
  })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ack' }],
      source: { kind: 'model', ...{ provider: 'mock', model: 'mock' } },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  // Closed turn: idle compaction (manual / cost-gate) refuses an open one.
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/**
 * Seed one closed turn ending in a small assistant tail, then open the next
 * turn (automatic compaction requires an enclosed turn; the loop appends this
 * `turn/start` before the turn's first pre-step). The pin is published first, so
 * it sits inside the span a pressure compaction selects.
 * @param session - the session to seed.
 * @returns the pin's session seq.
 */
function seedPressureSurface(session: Session): number {
  session.append('turn/start', { turn: 1 })
  const pinSeq = Number(session.append('user/message', governanceMessage(RULE), { surfaceOp: 'append' }).seq)
  for (const prompt of [NOISE, NOISE]) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ack' }],
      source: { kind: 'model', ...{ provider: 'mock', model: 'mock' } },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  return pinSeq
}

/** Every summary compaction the engine committed, in log order. */
function summaries(seen: readonly SessionEvent[]): SessionEvent<'compaction/summary'>[] {
  return seen.filter((event): event is SessionEvent<'compaction/summary'> => event.type === 'compaction/summary')
}

/** The checkpoint replacement events (surfaceOp `replace`) the engine committed. */
function checkpoints(seen: readonly SessionEvent[]): SessionEvent<'user/message'>[] {
  return seen.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && (event as unknown as { surfaceOp?: unknown }).surfaceOp !== 'append')
}

/** How many live copies of the pin the derived request history carries. */
function pinCopies(session: Session): number {
  return derivedUserTexts(session).filter((text) => text === RULE).length
}

/** Every regular file under a root (the JSONL generations the backend wrote). */
function filesUnder(root: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(root)) {
    const full = join(root, name)
    if (statSync(full).isDirectory()) out.push(...filesUnder(full))
    else out.push(full)
  }
  return out
}

/** Everything the backend has durably written for this rig, concatenated. */
function persistedText(root: string): string {
  return filesUnder(root).map((file) => readFileSync(file, 'utf8')).join('\n')
}

describe('integration — harness pressure auto-compaction (same-step restore)', () => {
  it('restores the pin inside the very pre-step whose inner listener compacted', async () => {
    const rig = await integrationRig()
    const pinSeq = seedPressureSurface(rig.agent.session)
    const stored = rig.states.peek('cp-integration')!.ring.get(pinSeq)!.message
    expect(stored.source).toEqual({ kind: 'turn-rules' })

    // Ordering probe: registered AFTER the engine, so it runs after the engine's
    // inner listener returned from its (awaited) compaction and BEFORE the
    // prepended drain's post-`next()` continuation. It therefore observes the
    // step mid-flight: the pin is already shadowed and not yet restored.
    let midStepCopies: number | undefined
    rig.ctx.on('agent/pre-step', async (
      payload: { agent: Agent },
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision> => {
      midStepCopies = pinCopies(payload.agent.session)
      return await next()
    })

    // ONE pre-step: the engine's own pressure listener (inner to the plugin's
    // prepended drain) compacts and commits the checkpoint in it.
    const decision = await runPreStep(rig, { turn: 2 })
    expect(decision.kind).toBe('enter')
    expect(midStepCopies).toBe(0)

    const summary = summaries(rig.seen)[0]
    expect(summary).toBeDefined()
    // The real span selection shadowed the pinned message, and the real
    // summarizer path went through the LLM seam (only the model is faked).
    expect((summary!.data as { shadowedSeqs: number[] }).shadowedSeqs).toContain(pinSeq)
    expect(rig.adapter.requests.some((request) => request.purpose === 'compaction')).toBe(true)

    // Same-step: the drain already ran on this step's post-`next()` continuation.
    expect(Plugin.getPinningHealth().restored).toBe(1)
    expect(rig.states.peek('cp-integration')!.schedules.size).toBe(0)
    expect(pinCopies(rig.agent.session)).toBe(1)

    const restored = rig.agent.session.deriveMessages().filter((message) => message.role === 'user'
      && message.content.some((block) => block.type === 'text' && block.text === RULE))
    // VERBATIM (§Restore): same content blocks, same source metadata object
    // shape — the session snapshots appends, so the observable form of "the
    // captured object was re-appended" is whole-message deep equality.
    expect(restored[0]).toStrictEqual(stored)
    expect(restored[0]!.content).toEqual(stored.content)
    expect(restored[0]!.source).toEqual(stored.source)
    expect((restored[0]!.source as { kind?: unknown }).kind).toBe('turn-rules')

    // Checkpoint intact: the engine's replacement node is still on the surface
    // and carries the framed summary the scripted adapter returned.
    const checkpoint = checkpoints(rig.seen)[0]!
    const checkpointSeq = Number(checkpoint.seq)
    expect([...rig.agent.session.surface.nodes]).toContain(checkpointSeq)
    expect(derivedUserTexts(rig.agent.session).some((text) => text.includes(SUMMARY_TEXT))).toBe(true)
    // Exactly one restore append — never a batch, never a duplicate.
    const restoredEvents = rig.seen.filter((event) => event.type === 'user/message'
      && Number(event.seq) > Number(checkpoint.seq)
      && (event as unknown as { surfaceOp?: unknown }).surfaceOp === 'append'
      && (event.data as UserMessage).content.some((block) => block.type === 'text' && block.text === RULE))
    expect(restoredEvents).toHaveLength(1)
  })

  it('loop safety: a second pressure compaction restores the re-captured pin again', async () => {
    const rig = await integrationRig()
    const originalSeq = seedPressureSurface(rig.agent.session)
    await runPreStep(rig, { turn: 2 })
    expect(Plugin.getPinningHealth().restored).toBe(1)

    // The restore re-entered the ring under a NEW seq (loop safety).
    const keys = rig.states.peek('cp-integration')!.ring.keys()
    expect(keys).toContain(originalSeq)
    expect(keys.some((seq) => seq > originalSeq)).toBe(true)
    const restoredSeq = Math.max(...keys)

    // Raise pressure again so the engine compacts a second, overlapping span
    // that includes the restored copy.
    for (const prompt of [NOISE, NOISE]) {
      rig.agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }
    rig.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'small tail' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await runPreStep(rig, { turn: 2, step: 2 })

    const compactions = summaries(rig.seen)
    expect(compactions).toHaveLength(2)
    expect((compactions[1]!.data as { shadowedSeqs: number[] }).shadowedSeqs).toContain(restoredSeq)
    // Exactly once per compaction, and never two live copies.
    expect(Plugin.getPinningHealth()).toMatchObject({ restored: 2, dropped: 0 })
    expect(pinCopies(rig.agent.session)).toBe(1)
  })
})

describe('integration — idle compaction sources (restore on the NEXT pre-step)', () => {
  /**
   * Seed an IDLE session (no open turn — the manual/idle precondition) that is
   * above threshold, and publish the pin.
   * @param agent - the rig's agent.
   * @returns the pin's seq.
   */
  function seedIdleSurface(agent: Agent): number {
    seedTurn(agent.session, 1, [NOISE])
    const pinSeq = Number(publish(agent, governanceMessage(RULE)).seq)
    seedTurn(agent.session, 2, [NOISE])
    return pinSeq
  }

  it('manual /compact (compactNow, idle) restores on the next pre-step, not before', async () => {
    const rig = await integrationRig()
    const pinSeq = seedIdleSurface(rig.agent)

    // The `/compact` seam: command-compact calls exactly this.
    const result = await rig.engine.compactNow(rig.agent, new AbortController().signal)
    expect(result).not.toBeNull()
    // Idle path, really: the lifecycle events carry `turn: null` (no open turn)
    // and the span selection shadowed the pin.
    expect(rig.seen.find((event) => event.type === 'compaction/end')!.data).toMatchObject({ turn: null })
    expect((summaries(rig.seen)[0]!.data as unknown as { shadowedSeqs: number[] }).shadowedSeqs).toContain(pinSeq)
    expect(pinCopies(rig.agent.session)).toBe(0)

    // Durable evidence through the REAL backend: the checkpoint is on disk.
    await rig.ctx.sessions.flush(rig.agent.session)
    const written = persistedText(rig.root)
    expect(written).toContain(SUMMARY_TEXT)
    expect(written).toContain('compaction/summary')

    // Nothing restores outside a pre-step: the schedule waits.
    expect(Plugin.getPinningHealth().restored).toBe(0)
    expect(rig.states.peek('cp-integration')!.schedules.size).toBe(1)

    rig.agent.session.append('turn/start', { turn: 3 })
    await runPreStep(rig, { turn: 3 })
    expect(pinCopies(rig.agent.session)).toBe(1)
    expect(Plugin.getPinningHealth().restored).toBe(1)
  })

  it('cost-gate idle seam (agent/status → compactNow) restores on the next pre-step', async () => {
    const rig = await integrationRig()
    seedIdleSurface(rig.agent)

    // The gate's idle path, shape-for-shape (compaction-cost-gate
    // registerListeners → evaluateIdle → compactNow, fire-and-forget): the real
    // gate plugin also needs its ledger home, cost settings, and todo boundary
    // machine, which are not what this case measures.
    let settle!: () => void
    const settled = new Promise<void>((resolve) => { settle = resolve })
    rig.ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: string }) => {
      if (status !== 'idle' || agent !== rig.agent) return
      void rig.engine.compactNow(agent, new AbortController().signal).finally(() => { settle() })
    })
    agentEvents(rig.ctx, rig.agent).emit('agent/status', { status: 'idle' })
    await settled

    expect(pinCopies(rig.agent.session)).toBe(0)
    expect(Plugin.getPinningHealth().restored).toBe(0)

    rig.agent.session.append('turn/start', { turn: 3 })
    await runPreStep(rig, { turn: 3 })
    expect(pinCopies(rig.agent.session)).toBe(1)
    expect(Plugin.getPinningHealth().restored).toBe(1)
  })
})

describe('integration — in-request retry paths (the accepted one-request gap)', () => {
  it('context-overflow retry: the retried derivation lacks the pin, the next pre-step restores it', async () => {
    const rig = await integrationRig()
    seedPressureSurface(rig.agent.session)

    // The loop's in-request recovery waterfall (compaction-basic registers the
    // overflow listener on it); the engine compacts and answers `retry`.
    const action = await agentEvents(rig.ctx, rig.agent).waterfall(
      'agent/request-error',
      {
        turn: 2,
        step: 1,
        provider: 'mock',
        failure: { message: 'context window exceeded', code: CONTEXT_WINDOW_EXCEEDED_CODE },
        retryPolicy: undefined,
        signal: new AbortController().signal,
      },
      () => Promise.resolve(undefined),
    )
    expect(action).toEqual({ kind: 'retry' })
    expect(summaries(rig.seen)).toHaveLength(1)

    // (a) The gap is REAL: the retry's own derivation — the surface as it
    // stands inside the same continuation — cannot carry the pin, because the
    // only append seam outside the firehose is the pre-step drain.
    expect(pinCopies(rig.agent.session)).toBe(0)
    expect(Plugin.getPinningHealth().restored).toBe(0)
    expect(rig.states.peek('cp-integration')!.schedules.size).toBe(1)

    // (b) …and BOUNDED: the very next pre-step restores it, once.
    await runPreStep(rig, { turn: 2, step: 2 })
    expect(pinCopies(rig.agent.session)).toBe(1)
    expect(Plugin.getPinningHealth().restored).toBe(1)
  })

  it('model-switch retry: the switched-to derivation lacks the pin, the next pre-step restores it', async () => {
    // The previous route has a large window; the switch target's window (400 →
    // threshold 200) is small enough that the history must be compacted before
    // the request can be built.
    const rig = await integrationRig({ contextWindow: 8_000 })
    seedPressureSurface(rig.agent.session)

    const selected = await agentEvents(rig.ctx, rig.agent).waterfall(
      'agent/request',
      { turn: 2, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ provider: 'tiny', model: 'tiny' }),
    )
    expect(selected).toEqual({ provider: 'tiny', model: 'tiny' })
    expect(summaries(rig.seen)).toHaveLength(1)
    // No pre-step ran in between: the engine compacted inside the request
    // waterfall, and it summarizes with the PREVIOUSLY routed model (the
    // committed header still identifies the model that can read the history).
    expect(rig.adapter.requests.filter((request) => request.purpose === 'compaction')).toHaveLength(1)

    expect(pinCopies(rig.agent.session)).toBe(0)
    expect(Plugin.getPinningHealth().restored).toBe(0)

    await runPreStep(rig, { turn: 2, step: 2 })
    expect(pinCopies(rig.agent.session)).toBe(1)
    expect(Plugin.getPinningHealth().restored).toBe(1)
  })
})
