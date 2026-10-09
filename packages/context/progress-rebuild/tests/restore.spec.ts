/**
 * Projection restore + measurement admission (design §5 item 5 and §5.3(g)):
 * the recorded event log restores through the REAL projection framework
 * (`registry.restore` / `registry.hydrate` on a FRESH composition) and must
 * reproduce the live-folded state (fixture equality); replay emits no
 * `session/event` dispatch and no `progress-rebuild/injected` measurement
 * rows (the live observer never fires on replay); and a stored log that
 * recorded `progress-rebuild/injected` reopens through the REAL jsonl
 * backend in a composition that loads this package — the
 * KNOWN_SESSION_EVENT_TYPES runtime-registration resume coupling
 * (session-cwd class, §3.3 step 4).
 *
 * @module
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'
import { appendProgressRebuildInjected, PROGRESS_REBUILD_INJECTED_EVENT } from '../src/events.ts'
import * as Plugin from '../src/index.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** The widened append face (events.ts precedent): fixture types skip the typed map. */
function appendEvent(session: Agent['session'], type: string, data: unknown, surface = false): void {
  ;(session.append as unknown as (t: string, d: unknown, opts: unknown) => unknown)(
    type, data, surface ? { surfaceOp: 'append' } : undefined)
}

/** Progress-state fixtures covering every derivation arm, appended directly to the live log. */
function seedProgress(session: Agent['session']): void {
  appendEvent(session, 'goal/change', {
    kind: 'goal/change',
    version: 1,
    operation: 'create',
    goal: { id: 'goal-1', revision: 1, objective: 'ship the restore spec', phase: 'active', maxGoalRounds: 5 },
    roundsStarted: 0,
    createdAt: 100,
    updatedAt: 100,
  })
  appendEvent(session, 'todo/write', { todos: [{ content: 'write the restore spec', status: 'in_progress' }] })
  appendEvent(session, 'tool/call', { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) })
  appendEvent(session, 'tool/result', {
    message: { isError: false, content: [{ type: 'text', text: 'ok' }], source: { callId: 'c1' } },
  }, true)
  appendEvent(session, 'user/message', createUserMessage({
    content: [{ type: 'text', text: 'keep shipping the feature' }],
    source: { kind: 'user' },
  }), true)
  // A delivered brief + its measurement row, exactly as delivery would commit them.
  appendEvent(session, 'user/message', createUserMessage({
    content: [{ type: 'text', text: 'Resume after compaction (auto-generated, derived from session events)' }],
    source: { kind: 'progress-rebuild' },
  }), true)
  appendProgressRebuildInjected(session, { bytes: 64, sections: 1, path: 'pre-step' })
}

/** The live composition: a real agent whose session log receives the fixtures. */
async function liveRig(): Promise<{ ctx: Context; agent: Agent; events: SessionEvent[] }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ok')]))
  // Collect the recorded log BEFORE agent creation (emit scope is captured per session).
  const events: SessionEvent[] = []
  ctx.on('session/event', (_session: unknown, event: SessionEvent) => { events.push(event) })
  await ctx.plugin(Plugin, { readSettings: () => ({ enabled: true, maxLines: 120, includeVerified: true }) })
  const agent = await ctx.agentLoop.create(SessionId('pr-restore-live'), { provider: 'mock', model: 'mock' })
  return { ctx, agent, events }
}

/** The resumed composition: a FRESH context that loads this package (§5 item 5). */
async function resumedRig(): Promise<{ ctx: Context; registry: SessionProjectionRegistry; rows: unknown[]; dispatched: number }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const rows: unknown[] = []
  let dispatched = 0
  ctx.on('session/event', (_session: unknown, event: SessionEvent) => {
    dispatched += 1
    if (String(event.type) === PROGRESS_REBUILD_INJECTED_EVENT) rows.push(event.data)
  })
  await ctx.plugin(Plugin, { readSettings: () => ({ enabled: true, maxLines: 120, includeVerified: true }) })
  const registry = ctx.get('sessionProjections') as SessionProjectionRegistry
  return { ctx, registry, rows, dispatched }
}

describe('projection restore + measurement admission (§5 item 5, §5.3(g))', () => {
  it('cold restore of the recorded log reproduces the live-folded state (fixture equality)', async () => {
    const { ctx, agent, events } = await liveRig()
    seedProgress(agent.session)
    const live = (ctx.get('sessionProjections') as SessionProjectionRegistry).stateOf(agent.session, 'progress-rebuild')
    // The fixtures landed: every derivation arm is non-degenerate.
    expect(live?.goal.current?.goal.objective).toBe('ship the restore spec')
    expect(live?.todos?.[0]?.status).toBe('in_progress')
    expect(live?.verified.map((receipt) => receipt.commandHead)).toEqual(['pnpm test'])
    expect(live?.lastUser?.text).toBe('keep shipping the feature')

    expect(events.length).toBeGreaterThan(0)
    expect(events[0]!.seq).toBe(0) // the full log: restore's cold-read base

    const { registry, rows, dispatched } = await resumedRig()
    const cold = registry.restore({}, events, SessionLogOffset(0), agent.session.header, agent.session.inheritedEventCount)
    expect(cold.checkpoint['progress-rebuild']?.val).toEqual(live)

    // §5.3(g): the replay path dispatches nothing and emits no measurement rows.
    expect(dispatched).toBe(0)
    expect(rows).toHaveLength(0)
  })

  it('incremental restore (checkpoint + forward tail) replays to the same state — the resume recipe', async () => {
    const { ctx, agent, events } = await liveRig()
    seedProgress(agent.session)
    const live = (ctx.get('sessionProjections') as SessionProjectionRegistry).stateOf(agent.session, 'progress-rebuild')
    const { registry, rows } = await resumedRig()

    const cut = Math.max(1, Math.floor(events.length / 2))
    const head = events.slice(0, cut)
    const tail = events.slice(cut)
    const first = registry.restore({}, head, SessionLogOffset(0), agent.session.header, agent.session.inheritedEventCount)
    const second = registry.restore(first.checkpoint, tail, SessionLogOffset(tail[0]!.seq as number), agent.session.header, agent.session.inheritedEventCount)
    expect(second.checkpoint['progress-rebuild']?.val).toEqual(live)
    expect(rows).toHaveLength(0)
  })

  it('hydrate installs the restored state so stateOf reads it on the resumed session', async () => {
    const { ctx, agent, events } = await liveRig()
    seedProgress(agent.session)
    const live = (ctx.get('sessionProjections') as SessionProjectionRegistry).stateOf(agent.session, 'progress-rebuild')
    const { registry, rows } = await resumedRig()
    const restored = registry.restore({}, events, SessionLogOffset(0), agent.session.header, agent.session.inheritedEventCount)
    const session2 = Session.create(SessionId('pr-restore-resumed'))
    registry.hydrate(session2, restored.checkpoint, events, SessionLogOffset(0))
    expect(registry.stateOf(session2, 'progress-rebuild')).toEqual(live)
    expect(rows).toHaveLength(0) // §5.3(g): materialization emits no rows
  })
})

describe('KNOWN admission through the real jsonl backend (§5 item 5, second half)', () => {
  it('registers progress-rebuild/injected into KNOWN_SESSION_EVENT_TYPES at module load (session-cwd precedent)', () => {
    expect((KNOWN_SESSION_EVENT_TYPES as Set<string>).has(PROGRESS_REBUILD_INJECTED_EVENT)).toBe(true)
  })

  it('a stored log containing progress-rebuild/injected reopens read+write in a composition that loads this package', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-jsonl-'))
    dirs.push(root)
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Plugin, { readSettings: () => ({ enabled: true, maxLines: 120, includeVerified: true }) })
    await ctx.plugin(JsonlSessionPersistence, { root })

    const seed = Session.create(SessionId('pr-jsonl-reopen'))
    const write = await ctx.sessionPersistence.create(seed.header)
    await write.append([
      { type: 'turn/start', seq: SessionSeq(0), time: 1000, data: { turn: 1 } },
      { type: PROGRESS_REBUILD_INJECTED_EVENT, seq: SessionSeq(1), time: 1001, data: { bytes: 1, sections: 1, path: 'pre-step' } },
    ] as never)
    await write.close()

    // A FRESH composition that loads this package reopens the log both ways:
    // the admission gate (validateStoredEvents) passes only because the
    // runtime registration ran at module load.
    const ctx2 = new Context()
    await mountAgentLoopTestDependencies(ctx2)
    await ctx2.plugin(Plugin, { readSettings: () => ({ enabled: true, maxLines: 120, includeVerified: true }) })
    await ctx2.plugin(JsonlSessionPersistence, { root })
    const read = await ctx2.sessionPersistence.open(SessionId('pr-jsonl-reopen'), 'read')
    const readBack = await read.read()
    expect(readBack.events.map((event) => String(event.type))).toContain(PROGRESS_REBUILD_INJECTED_EVENT)
    await read.close()
    const write2 = await ctx2.sessionPersistence.open(SessionId('pr-jsonl-reopen'), 'write')
    await write2.close()
  })
})
