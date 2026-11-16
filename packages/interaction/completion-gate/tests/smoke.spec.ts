/**
 * Turn-stopping synchronous-inject pin (plan
 * docs/plans/2026-10-09-runtime-verified-completion.md §5.6): the REAL agent
 * loop with a scripted mock model (advisor smoke.spec.ts pattern). The nudge
 * listener injects SYNCHRONOUSLY inside `agent/turn-stopping`, so the SAME
 * turn continues with target next-step — an additional step under the same
 * turn number, NO `turn/end` between the inject and the continuation, and the
 * nudge text present in the continuation's input. The same test doubles as
 * the "appends are legal at turn-stopping time" pin: the nudge-event append
 * inside the handler must not throw.
 *
 * @module
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { EXHAUSTED_EVENT, NUDGE_EVENT, UNVERIFIED_EVENT } from '../src/events.ts'
import { apply } from '../src/index.ts'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function boot(options: {
  writeSettings?: boolean
  settings?: Record<string, unknown>
  responses?: StreamChunk[][]
} = {}): Promise<{ ctx: Context; agent: Agent; mock: MockAdapter; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'cg-smoke-'))
  roots.push(root)
  const home = root
  await mkdir(join(home, 'completion-gate'), { recursive: true })
  if (options.writeSettings ?? true) {
    const section = { enabled: true, 'nudges-per-session': 2, ...(options.settings ?? {}) }
    await writeFile(join(home, 'settings.json'), JSON.stringify({ 'cc-completion-gate': section }), 'utf8')
  }
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  // Real JsonlSessionPersistence with the DEFAULT (zstd) compression — §5.8
  // forbids a 'none' stand-in.
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  const mock = new MockAdapter(options.responses ?? [
    textResponse('tests pass'),
    textResponse('you are right; running the suite now'),
    textResponse('tests pass'),
    textResponse('all good'),
  ])
  ctx.llm.registerAdapter(['mock'], mock)
  ;(ctx as unknown as { dshHomePath: (...s: string[]) => string }).dshHomePath = (...segments: string[]) => join(home, ...segments)
  ctx.provide('settings', {
    get: () => undefined,
    register: () => ({ get: () => undefined }),
  })
  apply(ctx)
  const agent = await ctx.agentLoop.create(
    SessionId('cg-smoke-1'),
    { provider: 'mock', model: 'mock' },
    { cwd: root },
  )
  return { ctx, agent, mock, root }
}

function userText(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function turn(agent: Agent, text: string): Promise<void> {
  agent.followup(userText(text))
  await agent.whenIdle()
}

describe('@dsh-cc/completion-gate smoke (§5.6, real loop)', () => {
  it('synchronous inject at turn-stopping continues the SAME turn; the nudge append does not throw', async () => {
    const { agent } = await boot()
    await turn(agent, 'run the tests please')

    const events = agent.session.snapshotEvents() as Array<{ type: string; data: any; seq?: number }>
    const nudges = events.filter(event => event.type === NUDGE_EVENT)
    // The in-handler append succeeded (did not throw through the handler).
    expect(nudges).toHaveLength(1)
    expect(nudges[0]!.data).toMatchObject({ claim: 'tests-green', missingReceipt: true })

    // The injected message carries our source kind and the nudge copy.
    const injected = events.filter(event =>
      event.type === 'user/message' && event.data?.source?.kind === 'completion-gate',
    )
    expect(injected).toHaveLength(1)
    expect(JSON.stringify(injected[0]!.data.content)).toContain('Evidence check:')
    expect(JSON.stringify(injected[0]!.data.content)).toContain('(completion-gate)')

    // Same-turn continuation: both assistant messages share the turn, and NO
    // turn/end sits between the injected message and the continuation.
    const claims = events.filter(event =>
      event.type === 'assistant/message' && JSON.stringify(event.data.message?.content).includes('tests pass'),
    )
    expect(claims.length).toBe(1)
    const claimTurn: number = claims[0]!.data.turn
    const injectedSeq = injected[0]!.seq!
    const continuation = events.find(event =>
      event.type === 'assistant/message' && (event.seq ?? 0) > injectedSeq,
    )
    expect(continuation).toBeDefined()
    expect(continuation!.data.turn).toBe(claimTurn)
    const ends = events.filter(event => event.type === 'turn/end' && event.data?.turn === claimTurn)
    expect(ends).toHaveLength(1)
    expect(ends[0]!.seq!).toBeGreaterThan(continuation!.seq!)
  }, 30_000)

  it('no settings file at all → the promoted default (ON) still nudges', async () => {
    const { agent } = await boot({ writeSettings: false })
    await turn(agent, 'run the tests please')
    const events = agent.session.snapshotEvents() as Array<{ type: string; data: any }>
    const nudges = events.filter(event => event.type === NUDGE_EVENT)
    // The default flipped to ON on 2026-11-11; an absent user file must not
    // silently keep the gate dark (fail-soft resolves to DEFAULT_GATE_SETTINGS).
    expect(nudges).toHaveLength(1)
    expect(nudges[0]!.data).toMatchObject({ claim: 'tests-green', missingReceipt: true })
  }, 30_000)

  it('a followup genuine turn still evaluates (followup/next-turn does not suppress)', async () => {
    const { agent } = await boot()
    // Turn 1 claims + nudges; turn 2 is a genuine followup claiming again.
    // With budget 2, turn 2 gets its OWN nudge — the followup input did NOT
    // suppress detection (§5.15 suppression scope).
    await turn(agent, 'run the tests please')
    await turn(agent, 'they pass for sure')
    const events = agent.session.snapshotEvents() as Array<{ type: string; data: any }>
    const nudges = events.filter(event => event.type === NUDGE_EVENT)
    expect(nudges).toHaveLength(2)
    expect(nudges[0]!.data.claim).toBe('tests-green')
    expect(nudges[1]!.data.claim).toBe('tests-green')
  }, 30_000)

  it('enforce: the inject continues the SAME turn (real loop, §5 case 17)', async () => {
    const { agent } = await boot({
      settings: { mode: 'enforce', 'enforce-max-cycles': 3 },
      responses: [textResponse('tests pass'), textResponse('you are right, I will not claim it')],
    })
    await turn(agent, 'run the tests please')
    await new Promise(resolve => setTimeout(resolve, 0))

    const events = agent.session.snapshotEvents() as Array<{ type: string; data: any; seq?: number }>
    const nudges = events.filter(event => event.type === NUDGE_EVENT)
    expect(nudges).toHaveLength(1)
    expect(nudges[0]!.data).toMatchObject({ claim: 'tests-green', cycle: 1 })

    const injected = events.filter(event =>
      event.type === 'user/message' && event.data?.source?.kind === 'completion-gate',
    )
    expect(injected).toHaveLength(1)
    expect(JSON.stringify(injected[0]!.data.content)).toContain('Completion gate (enforced):')
    expect(JSON.stringify(injected[0]!.data.content)).toContain('Gate cycles remaining: 2.')

    const claims = events.filter(event =>
      event.type === 'assistant/message' && JSON.stringify(event.data.message?.content).includes('tests pass'),
    )
    expect(claims).toHaveLength(1)
    const claimTurn: number = claims[0]!.data.turn
    const continuation = events.find(event =>
      event.type === 'assistant/message' && (event.seq ?? 0) > injected[0]!.seq!,
    )
    expect(continuation!.data.turn).toBe(claimTurn)
    expect(events.filter(event => event.type === 'turn/end' && event.data?.turn === claimTurn)).toHaveLength(1)
    // The claim was retracted: no exhaustion observation, no terminal marker.
    expect(events.filter(event => event.type === EXHAUSTED_EVENT)).toHaveLength(0)
    expect(events.filter(event => event.type === UNVERIFIED_EVENT)).toHaveLength(0)
  }, 30_000)

  it('enforce liveness: a model restating the claim forever still ends (§5 cases 13, 16)', async () => {
    const { ctx, agent, root } = await boot({
      settings: { mode: 'enforce', 'enforce-max-cycles': 2 },
      responses: [
        textResponse('tests pass'),
        textResponse('tests pass'),
        textResponse('tests pass'),
        textResponse('tests pass'),
      ],
    })
    await turn(agent, 'run the tests please')
    // The terminal marker is appended from a queueMicrotask (§3.5).
    await new Promise(resolve => setTimeout(resolve, 0))

    const events = agent.session.snapshotEvents() as Array<{ type: string; data: any }>
    // The loop TERMINATES: one turn end, two cycles, no third inject.
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(1)
    expect(events.filter(event => event.type === NUDGE_EVENT).map(event => event.data.cycle)).toEqual([1, 2])
    expect(events.filter(event =>
      event.type === 'user/message' && event.data?.source?.kind === 'completion-gate',
    )).toHaveLength(2)
    expect(events.filter(event => event.type === EXHAUSTED_EVENT)).toHaveLength(1)
    const unverified = events.filter(event => event.type === UNVERIFIED_EVENT)
    expect(unverified).toHaveLength(1)
    expect(unverified[0]!.data).toMatchObject({ turn: 1, claims: ['tests-green'] })

    // Reentry pin (§5 case 13): the DEFERRED append really landed in the
    // persisted log — the publication window did not swallow it.
    await ctx.sessions.flush(agent.session)
    const reopened = new Context()
    await reopened.plugin(JsonlSessionPersistence, { root })
    const reader = await reopened.sessionPersistence.open(SessionId('cg-smoke-1'), 'read')
    const replayed = (await reader.read()).events as Array<{ type: string }>
    await reader.close()
    expect(replayed.filter(event => event.type === EXHAUSTED_EVENT)).toHaveLength(1)
    expect(replayed.filter(event => event.type === UNVERIFIED_EVENT)).toHaveLength(1)
  }, 30_000)
})
