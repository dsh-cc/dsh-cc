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
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { NUDGE_EVENT } from '../src/events.ts'
import { apply } from '../src/index.ts'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function boot(): Promise<{ ctx: Context; agent: Agent; mock: MockAdapter }> {
  const root = await mkdtemp(join(tmpdir(), 'cg-smoke-'))
  roots.push(root)
  const home = root
  await mkdir(join(home, 'completion-gate'), { recursive: true })
  await writeFile(join(home, 'settings.json'), JSON.stringify({ 'cc-completion-gate': { enabled: true, 'nudges-per-session': 2 } }), 'utf8')
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  // Real JsonlSessionPersistence with the DEFAULT (zstd) compression — §5.8
  // forbids a 'none' stand-in.
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  const mock = new MockAdapter([
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
  return { ctx, agent, mock }
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
})
