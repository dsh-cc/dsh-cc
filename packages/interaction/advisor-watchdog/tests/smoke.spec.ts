/**
 * Smoke (plan docs/plans/2026-09-23-advisor-watchdog.md §5): the REAL agent
 * loop with a scripted mock model (mechanism-pins.spec.ts pattern). The main
 * lane's loop-stamped `llm/stream` events feed the snapshot listener; at
 * `agent/turn-stopping` the window is captured and the side call fires on the
 * scripted cheap lane (alias overlay haiku → deepseek/scripted on a fake
 * settings provider, because `onUnrouted:'skip'` rejects the inherit path).
 * Turn 1 is the init skip (cold start never billed); turn 2's window is
 * captured, the resolved blocker note is delivered via `agent.inject()` with
 * source kind `advisor`, the T2 re-open (mechanism-pins.spec.ts:103 contract)
 * runs exactly once, and the re-opened advisory turn's own turn-stopping must
 * NOT spawn a second run (no-genuine-user suppression + `advisor`-kind
 * filtering).
 *
 * @module
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from '../src/index.ts'
import { journalFileFor } from '../src/journal.ts'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** The advisor's scripted verdict: one blocker note. */
const BLOCKER_SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '{"notes":[{"severity":"blocker","text":"ignoring the explicit instruction to run the acceptance test"}]}' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '{"notes":[{"severity":"blocker","text":"ignoring the explicit instruction to run the acceptance test"}]}' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** Scripted cheap-lane adapter: records its calls (the advisor lane only). */
class ScriptedAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  script: readonly StreamChunk[] = BLOCKER_SCRIPT

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    for (const chunk of this.script) yield chunk
  }
}

const MODEL_ALIASES_OVERLAY = {
  haiku: { provider: 'deepseek', model: 'scripted' },
  'opus-class': { provider: 'deepseek', model: 'scripted' },
}

/** Scratch under the repo workspace — never /tmp. */
async function workspace(): Promise<string> {
  const scratch = join(process.cwd(), '.scratch')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'advisor-smoke-'))
  roots.push(root)
  return root
}

/**
 * Boot the real loop with the advisor mounted. `enabled` controls the
 * user-layer cc-advisor section; the fake settings provider carries the
 * §5 alias overlay (haiku → deepseek/scripted).
 */
async function boot(enabled: boolean, extras?: { subagents?: string }): Promise<{
  ctx: Context
  agent: Agent
  home: string
  advisor: ScriptedAdapter
  stops: number[]
}> {
  const root = await workspace()
  const home = root
  await mkdir(join(home, 'advisor'), { recursive: true })
  await writeFile(join(home, 'settings.json'), JSON.stringify({
    'cc-advisor': extras?.subagents !== undefined
      ? { enabled, subagents: extras.subagents }
      : { enabled },
  }), 'utf8')
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  // Generous script: turn 1, turn 2, the T2 re-open, and slack.
  const mock = new MockAdapter([textResponse('first answer'), textResponse('second answer'), textResponse('third answer'), textResponse('fourth answer'), textResponse('fifth answer'), textResponse('sixth answer'), textResponse('seventh answer'), textResponse('eighth answer')])
  ctx.llm.registerAdapter(['mock'], mock)
  const advisor = new ScriptedAdapter()
  ctx.llm.registerAdapter(['deepseek'], advisor)
  ;(ctx as unknown as { dshHomePath: (...s: string[]) => string }).dshHomePath =
    (...segments: string[]) => join(home, ...segments)
  ctx.provide('settings', {
    // Provider-level get: resolveAlias's read seam (service.ts:125); register:
    // registerNamespaceSafe's registration seam (fake per §5 — the advisor
    // calls runSideQuery with onUnrouted:'skip', which rejects inheritance).
    get: (ns: string) => (ns === 'model-aliases' ? MODEL_ALIASES_OVERLAY : undefined),
    register: () => ({
      get: (ns: string) => (ns === 'model-aliases' ? MODEL_ALIASES_OVERLAY : undefined),
    }),
  })
  apply(ctx)
  const agent = await ctx.agentLoop.create(
    SessionId('advisor-smoke-1'),
    { provider: 'mock', model: 'mock' },
    { cwd: join(root, 'workspace') },
  )
  const stops: number[] = []
  agent.ctx.on('agent/turn-stopping' as never, ({ turn }: { turn: number }): void => {
    stops.push(turn)
  })
  return { ctx, agent, home, advisor, stops }
}

function userText(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function turn(agent: Agent, text: string): Promise<void> {
  agent.followup(userText(text))
  await agent.whenIdle()
}

describe('@dsh-cc/advisor-watchdog smoke (plan §5, real loop)', () => {
  it('snapshot → turn-stopping capture → side call → advisor inject → T2 re-open exactly once; the re-opened advisory turn spawns nothing', async () => {
    const { agent, home, advisor, stops } = await boot(true)

    // Turn 1: the loop-stamped request is observed as the snapshot, but the
    // first observation inits the cursor — cold start is never billed.
    await turn(agent, 'fix the bug')
    expect(stops.length).toBeGreaterThanOrEqual(1)
    expect(advisor.calls).toHaveLength(0)

    // Turn 2: the completed turn-1 window contains a genuine user message →
    // one side query fires (detached).
    await turn(agent, 'continue with the plan')
    await vi.waitFor(() => {
      expect(advisor.calls).toHaveLength(1)
    }, { timeout: 10_000 })
    // The side query is a one-shot hand-built lane: no sessionId stamped.
    expect(advisor.calls[0].sessionId).toBeUndefined()

    // The blocker note is delivered via agent.inject() with source kind
    // `advisor`, and the T2 re-open runs exactly once more (the injected
    // advisory turn re-opens after turn-stopping).
    await vi.waitFor(() => {
      expect(stops.length).toBeGreaterThanOrEqual(2)
    }, { timeout: 10_000 })

    // The re-opened advisory turn's own turn-stopping must NOT spawn a second
    // run: the window contains only `advisor`-kind input plus the assistant's
    // reply — no genuine user message (and advisor kinds are filtered).
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(advisor.calls).toHaveLength(1)

    // Journal line exists with usage: null.
    const journal = JSON.parse(await readFile(journalFileFor(home, 'advisor-smoke-1'), 'utf8')) as Record<string, unknown>
    expect(journal.usage).toBeNull()
    expect(journal.ok).toBe(true)
    expect(journal.notesOut).toBe(1)
  }, 30_000)

  it('a follow-up genuine turn reviews its own window', async () => {
    const { agent, advisor } = await boot(true)
    // Turn 1: init skip — cold start never billed.
    await turn(agent, 'first request')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(advisor.calls).toHaveLength(0)

    // Turn 2: the completed turn-1 window has a genuine user message → run 1.
    await turn(agent, 'second request')
    await vi.waitFor(() => {
      expect(advisor.calls).toHaveLength(1)
    }, { timeout: 10_000 })
    await new Promise(resolve => setTimeout(resolve, 150))

    // Turn 3 (after the T2 re-open settles) is a fresh reviewable window → run 2.
    await turn(agent, 'third request')
    await vi.waitFor(() => {
      expect(advisor.calls).toHaveLength(2)
    }, { timeout: 10_000 })
  }, 30_000)

  it('disabled sessions make zero side calls', async () => {
    const { agent, advisor } = await boot(false)
    await turn(agent, 'user prompt')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(advisor.calls).toHaveLength(0)
  }, 30_000)

  it('subagent sessions are gated off by cc-advisor.subagents default', async () => {
    const { ctx, advisor } = await boot(true)
    // A child session header carries origin 'subagent' (§4.7: the settings
    // gate alone governs subagent sessions; default 'off').
    const child = (await ctx.agentLoop.create(
      SessionId('advisor-smoke-child'),
      { provider: 'mock', model: 'mock' },
      { cwd: process.cwd(), origin: 'subagent', delegationDepth: 1 },
    )) as unknown as Agent
    expect(child.session.header.origin).toBe('subagent')
    await turn(child, 'user in subagent')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(advisor.calls).toHaveLength(0)
  }, 30_000)

  it('a subagents alias string reviews subagent sessions on that lane (§4.7)', async () => {
    const { ctx, home, advisor } = await boot(true, { subagents: 'opus-class' })
    const child = (await ctx.agentLoop.create(
      SessionId('advisor-smoke-child-alias'),
      { provider: 'mock', model: 'mock' },
      { cwd: process.cwd(), origin: 'subagent', delegationDepth: 1 },
    )) as unknown as Agent
    // Turn 1: init skip; turn 2: the completed window has a genuine user
    // message → one side call on the OVERRIDE lane (journal records it).
    await turn(child, 'child request one')
    await turn(child, 'child request two')
    await vi.waitFor(() => {
      expect(advisor.calls).toHaveLength(1)
    }, { timeout: 10_000 })
    await vi.waitFor(async () => {
      const journal = JSON.parse(await readFile(journalFileFor(home, 'advisor-smoke-child-alias'), 'utf8')) as Record<string, unknown>
      expect(journal.alias).toBe('opus-class')
    }, { timeout: 10_000 })
  }, 30_000)
})
