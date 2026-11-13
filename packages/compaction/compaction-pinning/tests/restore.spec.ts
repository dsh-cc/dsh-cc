/**
 * Restore specs (design
 * docs/plans/2026-11-12-compaction-governed-pinning.md §Restore, §Restore
 * timing, §Verification):
 *
 * - the VERBATIM stored object reaches `deriveMessages()` — same content blocks,
 *   same source metadata, no invented `form`;
 * - restore order is ascending by ORIGINAL seq, and each pin is its own append
 *   (validated by the REAL session validator: a plain `user/message` append
 *   must carry `{ surfaceOp: 'append' }` — the r1 BLOCKER form);
 * - delegate-first ordering: a schedule armed by an INNER `agent/pre-step`
 *   listener (the engine's pressure trigger) drains in that SAME pre-step;
 * - loop safety: a restored message is re-captured under a new seq and a second
 *   compaction restores it again, once per compaction;
 * - drain-time append failure drops the entry, bumps `dropped`, and never
 *   throws across the waterfall boundary;
 * - the drain's registration options are `{ prepend: true }`, and a rejected
 *   step leaves the queue for the next admitted step.
 *
 * @module
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import * as Plugin from '../src/index.ts'
import {
  appendCompaction,
  derivedUserTexts,
  governanceMessage,
  humanMessage,
  liveRig,
  publish,
  resetCompactionIds,
  rigSettings,
  runPreStep,
  startTurn,
} from './rig.ts'

beforeEach(() => {
  Plugin.resetPinningHealth()
  resetCompactionIds()
})

/** The two governance texts that survive the round trip. */
const RULE = 'Always run the focused test before claiming a fix.'
const HINT = 'Re-run the failing test before reporting success.'

describe('restore — verbatim drain into the derived history', () => {
  it('restores the shadowed pin verbatim, under a fresh seq, exactly once', async () => {
    const rig = await liveRig()
    const event = publish(rig.agent, governanceMessage(RULE))
    const stored = rig.states.peek('cp-root')!.ring.get(event.seq)!.message
    startTurn(rig.agent.session, 1)

    const record = appendCompaction(rig.agent.session, { turn: 1 })
    // The checkpoint really shadowed the original: it is gone from the surface.
    expect(derivedUserTexts(rig.agent.session)).not.toContain(RULE)

    await runPreStep(rig, { turn: 1 })

    const derived = rig.agent.session.deriveMessages().filter((message) => message.role === 'user')
    const restored = derived.filter((message) => message.content.some(
      (block) => block.type === 'text' && block.text === RULE,
    ))
    expect(restored).toHaveLength(1)
    // VERBATIM: content blocks AND source metadata are the captured ones —
    // restorations keep the original source object, including its legal
    // (here: absent) `form` (§Current behavior, r1 fold).
    expect(restored[0]!.content).toEqual(stored.content)
    expect(restored[0]!.source).toEqual(stored.source)
    expect((restored[0]!.source as { kind?: unknown }).kind).toBe('turn-rules')
    // The restored copy is a NEW log event publishing the same payload.
    const restoredEvent = rig.seen.find((event: SessionEvent) => event.type === 'user/message'
      && event.seq > record.summarySeq
      && (event.data as UserMessage).content.some((block) => block.type === 'text' && block.text === RULE))
    expect(restoredEvent).toBeDefined()
    expect((restoredEvent as { surfaceOp?: unknown }).surfaceOp).toBe('append')
    expect(Plugin.getPinningHealth()).toMatchObject({ restored: 1, dropped: 0 })
  })

  it('drains ascending by ORIGINAL seq, one append per pin', async () => {
    const rig = await liveRig()
    const first = publish(rig.agent, governanceMessage(RULE))
    const second = publish(rig.agent, governanceMessage(HINT, 'edit-recovery-hint'))
    startTurn(rig.agent.session, 1)

    // The engine reports shadowed seqs in surface order; report them reversed
    // so only the original-seq ordering can produce the ascending drain.
    const record = appendCompaction(rig.agent.session, { turn: 1, shadowedSeqs: [second.seq, first.seq] })
    await runPreStep(rig, { turn: 1 })

    const texts = derivedUserTexts(rig.agent.session)
    const restoredTexts = texts.filter((text) => text === RULE || text === HINT)
    expect(restoredTexts).toEqual([RULE, HINT])
    // Each restore is its own append: two separate user/message events with the
    // legal append form, in ascending original-seq order. (The originals are
    // appends too, so only seqs after this compaction's summary count.)
    const appended = rig.seen.filter((event: SessionEvent) => event.type === 'user/message'
      && event.seq > record.summarySeq
      && (event as { surfaceOp?: unknown }).surfaceOp === 'append'
      && (event.data as UserMessage).content.some((block) => block.type === 'text'
        && (block.text === RULE || block.text === HINT)))
    expect(appended).toHaveLength(2)
    expect(appended.map((event) => (event.data as UserMessage).content[0]!.type === 'text'
      ? ((event.data as UserMessage).content[0] as { text: string }).text
      : '')).toEqual([RULE, HINT])
    expect(Plugin.getPinningHealth().restored).toBe(2)
  })

  it('same-step restore: a schedule armed by an INNER pre-step listener drains in that very pre-step', async () => {
    const rig = await liveRig()
    publish(rig.agent, governanceMessage(RULE))
    startTurn(rig.agent.session, 1)

    // The engine's own pressure trigger: an inner listener (registered after
    // the plugin, so it sits INSIDE the prepended drain) that compacts and then
    // delegates. Delegate-first means the drain sees the new schedule.
    rig.ctx.on('agent/pre-step', async (
      _payload: { agent: unknown },
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision> => {
      if (rig.states.peek('cp-root')!.schedules.size === 0) {
        appendCompaction(rig.agent.session, { turn: 1 })
      }
      return await next()
    })

    const decision = await runPreStep(rig, { turn: 1 })

    expect(decision.kind).toBe('enter')
    expect(derivedUserTexts(rig.agent.session)).toContain(RULE)
    expect(rig.states.peek('cp-root')!.schedules.size).toBe(0)
    expect(Plugin.getPinningHealth().restored).toBe(1)
  })

  it('loop safety: the restored message is re-captured under a NEW seq and a second compaction restores it again', async () => {
    const rig = await liveRig()
    const original = publish(rig.agent, governanceMessage(RULE))
    startTurn(rig.agent.session, 1)
    appendCompaction(rig.agent.session, { turn: 1 })
    await runPreStep(rig, { turn: 1 })
    expect(Plugin.getPinningHealth().restored).toBe(1)

    // Re-capture happened naturally through publication: the ring keeps the
    // (now shadowed) original AND the freshly published copy under a new seq.
    const keys = rig.states.peek('cp-root')!.ring.keys()
    expect(keys).toHaveLength(2)
    const recapturedSeq = keys.find((seq) => seq !== original.seq)
    expect(recapturedSeq).toBeDefined()
    expect(recapturedSeq!).toBeGreaterThan(original.seq)
    const recaptured = rig.states.peek('cp-root')!.ring.get(recapturedSeq!)!.message
    expect((recaptured.source as { kind?: unknown }).kind).toBe('turn-rules')
    expect(recaptured.content).toEqual(governanceMessage(RULE).content)

    // Second compaction shadows the restored copy; it comes back once more.
    startTurn(rig.agent.session, 2)
    appendCompaction(rig.agent.session, { turn: 2 })
    expect(derivedUserTexts(rig.agent.session)).not.toContain(RULE)
    await runPreStep(rig, { turn: 2 })

    expect(derivedUserTexts(rig.agent.session).filter((text) => text === RULE)).toHaveLength(1)
    expect(Plugin.getPinningHealth()).toMatchObject({ restored: 2, dropped: 0 })
  })

  it('leaves no duplicate when two eligible schedules carry the same shadowed pin', async () => {
    const rig = await liveRig()
    const pin = publish(rig.agent, governanceMessage(RULE))
    startTurn(rig.agent.session, 1)

    // Two independent compactions reporting the same restorable seq (possible
    // when both summaries precede the single drain). One live copy only.
    appendCompaction(rig.agent.session, { turn: 1, omitEnd: true })
    appendCompaction(rig.agent.session, { turn: 1, shadowedSeqs: [pin.seq] })
    await runPreStep(rig, { turn: 1 })

    expect(derivedUserTexts(rig.agent.session).filter((text) => text === RULE)).toHaveLength(1)
    expect(Plugin.getPinningHealth().restored).toBe(1)
  })

  it('restores nothing while the feature is disabled (a pending schedule survives the pause)', async () => {
    const rig = await liveRig()
    publish(rig.agent, governanceMessage(RULE))
    startTurn(rig.agent.session, 1)
    appendCompaction(rig.agent.session, { turn: 1 })

    rig.settings.enabled = false
    await runPreStep(rig, { turn: 1 })
    expect(Plugin.getPinningHealth().restored).toBe(0)
    expect(rig.states.peek('cp-root')!.schedules.size).toBe(1)

    // Re-enabling resumes the drain — rule (a) is still satisfied.
    rig.settings.enabled = true
    await runPreStep(rig, { turn: 2 })
    expect(derivedUserTexts(rig.agent.session)).toContain(RULE)
    expect(Plugin.getPinningHealth().restored).toBe(1)
  })
})

describe('restore — waterfall contract', () => {
  it('hands the inner decision through untouched (and restores after it)', async () => {
    const rig = await liveRig()
    publish(rig.agent, governanceMessage(RULE))
    startTurn(rig.agent.session, 1)
    appendCompaction(rig.agent.session, { turn: 1 })

    const inner: UserMessage[] = [humanMessage('inner decision message')]
    const decision = await runPreStep(rig, { turn: 1, decision: { kind: 'enter', messages: inner } })

    expect(decision.kind).toBe('enter')
    expect(decision.kind === 'enter' ? decision.messages : []).toEqual(inner)
    expect(derivedUserTexts(rig.agent.session)).toContain(RULE)
  })

  it('a rejected step defers the queue instead of spending it', async () => {
    const rig = await liveRig()
    publish(rig.agent, governanceMessage(RULE))
    startTurn(rig.agent.session, 1)
    appendCompaction(rig.agent.session, { turn: 1 })

    await runPreStep(rig, { turn: 1, decision: { kind: 'reject' } })
    expect(Plugin.getPinningHealth().restored).toBe(0)
    expect(rig.states.peek('cp-root')!.schedules.size).toBe(1)

    await runPreStep(rig, { turn: 2 })
    expect(derivedUserTexts(rig.agent.session)).toContain(RULE)
  })
})

// ---------------------------------------------------------------------------
// Listener-level containment (a stub context: the drain's failure path is a
// dispatch-level contract, and the harness owns real session disposal).
// ---------------------------------------------------------------------------

interface StubCtx {
  ctx: Context
  handlers: Map<string, (...args: unknown[]) => unknown>
  options: Map<string, unknown>
}

function stubCtx(): StubCtx {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const options = new Map<string, unknown>()
  const ctx = {
    on: (name: string, handler: (...args: unknown[]) => unknown, opts?: unknown) => {
      handlers.set(name, handler)
      options.set(name, opts)
      return () => {}
    },
    logger: { debug: () => {}, warn: () => {} },
  }
  return { ctx: ctx as unknown as Context, handlers, options }
}

/** A session stub whose `append` fails the way a disposed session does. */
function failingSession(id: string): Session {
  return {
    header: { id },
    append: () => { throw new Error(`session "${id}" cannot append outside a SessionStore`) },
  } as unknown as Session
}

describe('restore — failure semantics and registration', () => {
  it('registers the drain with { prepend: true } (the same-step ordering contract)', () => {
    const stub = stubCtx()
    const states = Plugin.createPinningStateRegistry(() => rigSettings())
    Plugin.registerRestore(stub.ctx, () => rigSettings(), states)

    expect([...stub.handlers.keys()]).toEqual(['agent/pre-step'])
    expect(stub.options.get('agent/pre-step')).toEqual({ prepend: true })
  })

  it('drops every entry (and counts it) when the session refuses the append — never throws', async () => {
    const stub = stubCtx()
    const settings = rigSettings()
    const states = Plugin.createPinningStateRegistry(() => settings)
    Plugin.registerDetect(stub.ctx, () => settings, states)
    Plugin.registerRestore(stub.ctx, () => settings, states)
    // Capture-side state is built by hand here: the firehose capture path is
    // task A's spec; this test needs only a scheduled, eligible queue.
    const session = failingSession('s-1')
    const state = states.stateOf('s-1')
    state.ring.add({ seq: 4, message: governanceMessage(RULE), ts: 1 })
    state.schedules.arm('cp-1', [{ seq: 4, message: governanceMessage(RULE) }], 1)
    state.schedules.succeed('cp-1')

    const listener = stub.handlers.get('agent/pre-step')!
    const decision = await listener({ agent: { session }, turn: 1 }, async () => ({ kind: 'enter', messages: [] }))

    expect(decision).toEqual({ kind: 'enter', messages: [] })
    expect(Plugin.getPinningHealth()).toMatchObject({ restored: 0, dropped: 1 })
    // The queue was consumed exactly once — no retry loop on a dead session.
    expect(state.schedules.size).toBe(0)
  })

  it('a throwing settings reader degrades to a no-op, not a waterfall failure', async () => {
    const stub = stubCtx()
    const states = Plugin.createPinningStateRegistry(() => rigSettings())
    Plugin.registerRestore(stub.ctx, () => { throw new Error('boom') }, states)
    const state = states.stateOf('s-1')
    state.schedules.arm('cp-1', [{ seq: 1, message: governanceMessage(RULE) }], 0)
    state.schedules.succeed('cp-1')

    const listener = stub.handlers.get('agent/pre-step')!
    const decision = await listener(
      { agent: { session: failingSession('s-1') }, turn: 2 },
      async () => ({ kind: 'enter', messages: [] }),
    )
    expect(decision).toEqual({ kind: 'enter', messages: [] })
    expect(Plugin.getPinningHealth()).toMatchObject({ restored: 0, dropped: 0 })
  })
})
