/**
 * Capture specs (design
 * docs/plans/2026-11-12-compaction-governed-pinning.md §Verification):
 *
 * - capture read shape exercised against REAL published `user/message` events —
 *   the r1 BLOCKER (reading `event.data.message.*` instead of `event.data`) is
 *   pinned by a regression test;
 * - verbatim capture (the stored object IS the published object);
 * - the kind filter (match / no source / non-pinned kind / configured kinds);
 * - the failure semantics (store refusal and throwing readers drop + count, and
 *   never cross the firehose boundary);
 * - Session-disposal cleanup;
 * - the four-surface settings default discipline.
 *
 * The live rig is the progress-rebuild one (REAL agent loop + REAL session log,
 * only the model mocked): events are published by appending to the session the
 * loop created, so the capture listener sees exactly what production sees.
 *
 * @module
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'
import * as Plugin from '../src/index.ts'

// The two pinned kinds already exist as producers; the specs declare the same
// merge augmentation their producers do (turn-rules/src/wiring.ts:62-66,
// post-edit-verify/src/recovery-wiring.ts:18-22).
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'turn-rules': { kind: 'turn-rules' } & ContextFormed
    'edit-recovery-hint': { kind: 'edit-recovery-hint' } & ContextFormed
  }
}

/** The governance source kinds under test. */
type GovernanceKind = 'turn-rules' | 'edit-recovery-hint'

/** One governance message, built through the real factory. */
function governanceMessage(text: string, kind: GovernanceKind = 'turn-rules'): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: kind === 'turn-rules' ? { kind: 'turn-rules' } : { kind: 'edit-recovery-hint' },
  })
}

/** Live settings, default-derived (four-surface discipline: never a literal). */
function rigSettings(
  overrides: Partial<Plugin.CompactionPinningSettings> = {},
): Plugin.CompactionPinningSettings {
  return { ...Plugin.DEFAULT_COMPACTION_PINNING_SETTINGS, ...overrides }
}

/** The real-composition rig: real loop, real session, mocked model only. */
interface Rig {
  ctx: Context
  agent: Agent
  states: Plugin.PinningStateRegistry
  seen: SessionEvent[]
  settings: Plugin.CompactionPinningSettings
}

async function liveRig(overrides: Partial<Plugin.CompactionPinningSettings> = {}): Promise<Rig> {
  const settings = rigSettings(overrides)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ok')]))
  // Subscribe BEFORE agent creation: session events dispatch to the session's
  // captured emit scope, so late subscribers see nothing.
  const seen: SessionEvent[] = []
  ctx.on('session/event', (_session: unknown, event: SessionEvent) => { seen.push(event) }, { global: true })
  const states = Plugin.createPinningStateRegistry(() => settings)
  await ctx.plugin(Plugin, { readSettings: () => settings, states })
  const agent = await ctx.agentLoop.create(SessionId('cp-root'), { provider: 'mock', model: 'mock' })
  return { ctx, agent, states, seen, settings }
}

/** Publish one `user/message` through the real session append path. */
function publish(agent: Agent, message: UserMessage): SessionEvent & { seq: number } {
  return agent.session.append('user/message', message, { surfaceOp: 'append' }) as SessionEvent & { seq: number }
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  // Counters are process-wide.
  Plugin.resetPinningHealth()
})

describe('capture from real published user/message events', () => {
  it('pins a turn-rules message read through event.data (r1 shape regression)', async () => {
    const rig = await liveRig()
    const text = 'Always run the focused test before claiming a fix.'
    const event = publish(rig.agent, governanceMessage(text))

    // The r1 BLOCKER: a `user/message` event carries the UserMessage ITSELF as
    // `data` (harness core/session/src/types.ts:315) — there is no `.message`
    // wrapper. Capture must therefore read `event.data.source/.content`.
    expect((event.data as unknown as { message?: unknown }).message).toBeUndefined()

    const state = rig.states.peek('cp-root')
    expect(state).toBeDefined()
    expect(state!.ring.keys()).toEqual([event.seq])
    const entry = state!.ring.get(event.seq)!
    expect(entry.seq).toBe(event.seq)
    expect(entry.ts).toBe(event.time)
    expect((entry.message.source as { kind?: unknown }).kind).toBe('turn-rules')
    expect(entry.message.content[0]).toMatchObject({ type: 'text', text })
    expect(Plugin.getPinningHealth()).toMatchObject({ captured: 1, dropped: 0 })
  })

  it('stores the published object verbatim — the ring holds the very object the event carried', async () => {
    const rig = await liveRig()
    const event = publish(rig.agent, governanceMessage('Keep the ring verbatim.', 'edit-recovery-hint'))

    const published = rig.seen.find((item) => item.seq === event.seq)
    expect(published).toBeDefined()
    const entry = rig.states.peek('cp-root')!.ring.get(event.seq)!
    // Identity, not deep equality: capture does not clone or destructure.
    expect(entry.message).toBe(published!.data)
    expect((entry.message.source as { kind?: unknown }).kind).toBe('edit-recovery-hint')
  })

  it('captures only the configured kinds (match / non-pinned kind)', async () => {
    const rig = await liveRig()
    const pinned = publish(rig.agent, governanceMessage('pinned reminder'))
    // A genuine human prompt: kind 'user'.
    publish(rig.agent, createUserMessage({
      content: [{ type: 'text', text: 'a human prompt' }],
      source: { kind: 'user' },
    }))
    const hint = publish(rig.agent, governanceMessage('recovery hint', 'edit-recovery-hint'))

    expect(rig.states.peek('cp-root')!.ring.keys()).toEqual([pinned.seq, hint.seq])
    expect(Plugin.getPinningHealth().captured).toBe(2)
  })

  it('honours a narrowed pinned-source-kinds setting', async () => {
    const rig = await liveRig({ pinnedSourceKinds: ['edit-recovery-hint'] })
    publish(rig.agent, governanceMessage('turn-rules reminder'))
    const hint = publish(rig.agent, governanceMessage('recovery hint', 'edit-recovery-hint'))

    expect(rig.states.peek('cp-root')!.ring.keys()).toEqual([hint.seq])
  })

  it('captures nothing while the feature is disabled', async () => {
    const rig = await liveRig({ enabled: false })
    publish(rig.agent, governanceMessage('pinned reminder'))

    expect(rig.states.peek('cp-root')).toBeUndefined()
    expect(Plugin.getPinningHealth()).toMatchObject({ captured: 0, dropped: 0 })
  })

  it('applies the entry cap through the hot-read settings (FIFO eviction)', async () => {
    const rig = await liveRig({ maxPinned: 2 })
    const first = publish(rig.agent, governanceMessage('pin one'))
    const second = publish(rig.agent, governanceMessage('pin two'))
    const third = publish(rig.agent, governanceMessage('pin three'))

    expect(rig.states.peek('cp-root')!.ring.keys()).toEqual([second.seq, third.seq])
    expect(rig.states.peek('cp-root')!.ring.has(first.seq)).toBe(false)
    expect(Plugin.getPinningHealth()).toMatchObject({ captured: 3, evicted: 1 })
  })

  it('drops (and counts) a pin that alone exceeds max-pinned-bytes', async () => {
    const rig = await liveRig({ maxPinnedBytes: Plugin.MIN_PINNED_BYTES })
    const oversized = governanceMessage('x'.repeat(4_096))
    publish(rig.agent, oversized)

    expect(rig.states.peek('cp-root')!.ring.size).toBe(0)
    expect(Plugin.getPinningHealth()).toMatchObject({ captured: 0, dropped: 1 })
  })

  it('wiring: mounted with NO settings seams, the documented defaults capture (no settings file → capture runs)', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ok')]))
    // Production wiring: namespace reader when the host has a settings provider,
    // documented defaults otherwise — never a per-key literal (§Settings).
    await ctx.plugin(Plugin)
    const agent = await ctx.agentLoop.create(SessionId('cp-bare'), { provider: 'mock', model: 'mock' })

    publish(agent, governanceMessage('default kinds capture this'))

    expect(Plugin.getPinningHealth()).toMatchObject({ captured: 1, dropped: 0 })
  })
})

// ---------------------------------------------------------------------------
// Listener-level containment + cleanup (a stub context: the cleanup path is a
// dispatch-level contract, and the harness owns the real agent/session teardown).
// ---------------------------------------------------------------------------

interface StubCtx {
  ctx: Context
  handlers: Map<string, (...args: unknown[]) => unknown>
  fired(name: string, ...args: unknown[]): void
}

function stubCtx(): StubCtx {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ctx = {
    on: (name: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(name, handler)
      return () => {}
    },
    logger: { debug: () => {}, warn: () => {} },
  }
  return {
    ctx: ctx as unknown as Context,
    handlers,
    fired: (name, ...args) => { handlers.get(name)!(...args) },
  }
}

/** A session-shaped stub (only `header.id` is read). */
function stubSession(id: string): Session {
  return { header: { id } } as unknown as Session
}

/** A published-event-shaped stub. */
function stubEvent(seq: number, message: UserMessage): SessionEvent {
  return { type: 'user/message', seq, time: 1_700_000_000_000, data: message } as unknown as SessionEvent
}

describe('capture failure semantics and Session disposal', () => {
  it('contains a throwing settings reader: drop + count, never throw across the firehose', () => {
    const stub = stubCtx()
    const states = Plugin.createPinningStateRegistry(() => rigSettings())
    Plugin.registerCapture(stub.ctx, () => { throw new Error('boom') }, states)

    expect(() => stub.fired('session/event', stubSession('s-1'), stubEvent(1, governanceMessage('pin')))).not.toThrow()
    expect(Plugin.getPinningHealth()).toMatchObject({ dropped: 1, captured: 0 })
    expect(states.peek('s-1')).toBeUndefined()
  })

  it('ignores a message with no source kind (kindless source and absent source)', () => {
    const stub = stubCtx()
    const states = Plugin.createPinningStateRegistry(() => rigSettings())
    Plugin.registerCapture(stub.ctx, () => rigSettings(), states)

    const kindless = { ...governanceMessage('kindless'), source: {} } as unknown as UserMessage
    const sourceLess = {
      id: 'm-2',
      role: 'user',
      content: [{ type: 'text', text: 'bare' }],
    } as unknown as UserMessage
    stub.fired('session/event', stubSession('s-1'), stubEvent(1, kindless))
    stub.fired('session/event', stubSession('s-1'), stubEvent(2, sourceLess))
    stub.fired('session/event', stubSession('s-1'), stubEvent(3, governanceMessage('pin')))

    expect(states.peek('s-1')!.ring.keys()).toEqual([3])
  })

  it('drops the whole session state on session/disposed', () => {    const stub = stubCtx()
    const states = Plugin.createPinningStateRegistry(() => rigSettings())
    Plugin.registerCapture(stub.ctx, () => rigSettings(), states)

    stub.fired('session/event', stubSession('s-1'), stubEvent(1, governanceMessage('pin')))
    stub.fired('session/event', stubSession('s-2'), stubEvent(2, governanceMessage('pin')))
    expect(states.ids().sort()).toEqual(['s-1', 's-2'])

    stub.fired('session/disposed', stubSession('s-1'))
    expect(states.peek('s-1')).toBeUndefined()
    expect(states.ids()).toEqual(['s-2'])
  })
})

// ---------------------------------------------------------------------------
// Four-surface default discipline (repo hard rule): schema defaults, the
// DEFAULT_* / DEFAULT_COMPACTION_PINNING_SETTINGS constants, the raw-reader
// fallback, and the wiring reader must all carry the same values.
// ---------------------------------------------------------------------------

describe('settings defaults (four-surface discipline)', () => {
  it('the DEFAULT_* constants and the resolved-defaults object agree', () => {
    expect(Plugin.DEFAULT_COMPACTION_PINNING_SETTINGS).toEqual({
      enabled: Plugin.DEFAULT_ENABLED,
      pinnedSourceKinds: [...Plugin.DEFAULT_PINNED_SOURCE_KINDS],
      maxPinned: Plugin.DEFAULT_MAX_PINNED,
      maxPinnedBytes: Plugin.DEFAULT_MAX_PINNED_BYTES,
    })
    expect(Plugin.DEFAULT_ENABLED).toBe(true)
    expect(Plugin.DEFAULT_PINNED_SOURCE_KINDS).toEqual(['turn-rules', 'edit-recovery-hint'])
    expect(Plugin.DEFAULT_MAX_PINNED).toBe(16)
    expect(Plugin.DEFAULT_MAX_PINNED_BYTES).toBe(16_384)
    // Documented bounds (§Settings table).
    expect([Plugin.MIN_PINNED, Plugin.MAX_PINNED]).toEqual([1, 64])
    expect([Plugin.MIN_PINNED_BYTES, Plugin.MAX_PINNED_BYTES]).toEqual([1_024, 262_144])
  })

  it('the schema surface resolves an absent section to the same defaults', () => {
    const resolve = Plugin.SettingsSchema as unknown as (value: unknown) => Record<string, unknown>
    const resolved = resolve({})
    expect(resolved['enabled']).toBe(Plugin.DEFAULT_ENABLED)
    expect(resolved['pinned-source-kinds']).toEqual([...Plugin.DEFAULT_PINNED_SOURCE_KINDS])
    expect(resolved['max-pinned']).toBe(Plugin.DEFAULT_MAX_PINNED)
    expect(resolved['max-pinned-bytes']).toBe(Plugin.DEFAULT_MAX_PINNED_BYTES)
  })

  it('the raw reader falls back to the same defaults (absent file → capture runs)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cp-settings-'))
    dirs.push(home)
    await expect(Plugin.readUserSettings(home)).resolves.toEqual(Plugin.DEFAULT_COMPACTION_PINNING_SETTINGS)
  })

  it('the raw reader resolves a configured section and drops over-long kinds', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cp-settings-'))
    dirs.push(home)
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
      [Plugin.SETTINGS_NAMESPACE]: {
        'pinned-source-kinds': ['turn-rules', 'x'.repeat(Plugin.MAX_SOURCE_KIND_CHARS + 1)],
        'max-pinned': 8,
      },
    }))
    await expect(Plugin.readUserSettings(home)).resolves.toEqual({
      enabled: Plugin.DEFAULT_ENABLED,
      pinnedSourceKinds: ['turn-rules'],
      maxPinned: 8,
      maxPinnedBytes: Plugin.DEFAULT_MAX_PINNED_BYTES,
    })
  })

  it('the raw reader fails soft on malformed JSON and on out-of-range values', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cp-settings-'))
    dirs.push(home)
    writeFileSync(join(home, 'settings.json'), '{ not json')
    await expect(Plugin.readUserSettings(home)).resolves.toEqual(Plugin.DEFAULT_COMPACTION_PINNING_SETTINGS)

    writeFileSync(join(home, 'settings.json'), JSON.stringify({
      [Plugin.SETTINGS_NAMESPACE]: { 'max-pinned': Plugin.MAX_PINNED + 1 },
    }))
    await expect(Plugin.readUserSettings(home)).resolves.toEqual(Plugin.DEFAULT_COMPACTION_PINNING_SETTINGS)
  })

  it('an empty pinned-source-kinds list falls back to the default pair (opt out via enabled)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cp-settings-'))
    dirs.push(home)
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
      [Plugin.SETTINGS_NAMESPACE]: { 'pinned-source-kinds': [] },
    }))
    const resolved = await Plugin.readUserSettings(home)
    expect(resolved.pinnedSourceKinds).toEqual([...Plugin.DEFAULT_PINNED_SOURCE_KINDS])
  })
})
