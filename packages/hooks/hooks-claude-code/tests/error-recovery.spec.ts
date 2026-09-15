import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as HooksClaude from '@dsh-cc/hooks-claude-code'
import { MockAdapter, maxTokensResponse, textResponse } from '@dsh-cc/agent-loop-mock'
import { CONTINUATION_TEXT, createContinuation, lastAttemptHitCeiling } from '../src/continuation.ts'
import { createErrorStreak } from '../src/error-streak.ts'

/**
 * Error-recovery parity tests (plan 2026-09-15 §2): A1 stop-on-error parity
 * lock (Stop never runs on error/aborted turns), A2 agent-error streak
 * surfacing, A3 max-tokens continuation. Real agent loop + the REAL bridge;
 * only the model is mocked (scripted MockAdapter failures/responses).
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
afterEach(() => {
  delete process.env.CLAUDE_CODE_AGENT_ERROR_CONSECUTIVE_CAP
  delete process.env.CLAUDE_CODE_AGENT_ERROR_TOTAL_CAP
  delete process.env.CLAUDE_CODE_OUTPUT_TOKEN_CONTINUATION_CAP
})

function dir(): string { const d = mkdtempSync(join(tmpdir(), 'dsh-errorrec-')); dirs.push(d); return d }
function sh(d: string, name: string, body: string): string {
  const p = join(d, name); writeFileSync(p, body); chmodSync(p, 0o755); return p
}
function hooks(d: string, h: unknown): string {
  writeFileSync(join(d, 'hooks.json'), JSON.stringify({ hooks: h })); return join(d, 'hooks.json')
}

async function harness(configPath: string, adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(HooksClaude, { configPath })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

async function waitForIdle(_ctx: Context, agent: Agent): Promise<void> { return agent.whenIdle() }
async function waitFor(predicate: () => boolean, timeout = 5000, interval = 10): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before deadline')
    await new Promise(r => setTimeout(r, interval))
  }
}

/** A Stop hook that records one line per invocation (exit 0, never blocks). */
function recordingStop(d: string): { runs: string; command: string } {
  const runs = join(d, 'stop-runs')
  const command = sh(d, 'stop.sh', `#!/usr/bin/env bash
payload=$(cat) >/dev/null
n=$(cat "${runs}" 2>/dev/null || echo 0); echo $((n+1)) > "${runs}"
exit 0
`)
  return { runs, command }
}
function runCount(runs: string): number {
  return existsSync(runs) ? Number(readFileSync(runs, 'utf8').trim().split('\n').pop()) : 0
}

/** A StopFailure hook that records each raw payload line. */
function recordingStopFailure(d: string): { flags: string; command: string } {
  const flags = join(d, 'sf-flags')
  const command = sh(d, 'sf.sh', `#!/usr/bin/env bash
cat >> "${flags}"
echo "" >> "${flags}"
exit 0
`)
  return { flags, command }
}
function sfLines(flags: string): Record<string, unknown>[] {
  if (!existsSync(flags)) return []
  return readFileSync(flags, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as Record<string, unknown>)
}

describe('A1: stop-on-error parity lock', () => {
  it('an LLM-error turn never invokes Stop but runs StopFailure exactly once with the classified error_code', async () => {
    const d = dir()
    const stop = recordingStop(d)
    const sf = recordingStopFailure(d)
    const path = hooks(d, {
      Stop: [{ hooks: [{ type: 'command', command: stop.command }] }],
      StopFailure: [{ hooks: [{ type: 'command', command: sf.command }] }],
    })
    const adapter = new MockAdapter([() => { throw new Error('rate limit exceeded') }])
    const ctx = await harness(path, adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    await waitFor(() => sfLines(sf.flags).length >= 1)
    // Parity lock: the death-spiral vector — Stop running on API-error turns —
    // must stay impossible (turn-stopping is not dispatched on the error path).
    expect(existsSync(stop.runs)).toBe(false)
    const payloads = sfLines(sf.flags)
    expect(payloads).toHaveLength(1)
    expect(payloads[0].hook_event_name).toBe('StopFailure')
    expect(payloads[0].error_code).toBe('rate_limit')
  }, 30_000)

  it('a normally-completing turn still runs Stop (guarded baseline)', async () => {
    const d = dir()
    const stop = recordingStop(d)
    const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command: stop.command }] }] })
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await harness(path, adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    await waitFor(() => runCount(stop.runs) >= 1)
    expect(runCount(stop.runs)).toBe(1)
  }, 30_000)

  it('an aborted turn does not invoke Stop', async () => {
    const d = dir()
    const stop = recordingStop(d)
    const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command: stop.command }] }] })
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(path, adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await new Promise(r => setTimeout(r, 100))
    agent.cancel({ kind: 'user', reason: 'test abort' })
    await waitForIdle(ctx, agent)
    await new Promise(r => setTimeout(r, 50))
    expect(existsSync(stop.runs)).toBe(false)
  }, 30_000)
})

/** A fake enough Agent for the streak/continuation state units (id + session only). */
function fakeAgent(id: string, sessionId: string, steer: ReturnType<typeof vi.fn> = vi.fn()): Agent {
  return {
    id,
    steer,
    inject: vi.fn(),
    session: { header: { id: sessionId }, snapshotEvents: () => [] },
  } as unknown as Agent
}

function streakCtx(): { ctx: Context; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn()
  const ctx = { logger: { warn, info: vi.fn() } } as unknown as Context
  return { ctx, warn }
}

describe('A2: agent-error streak surfacing', () => {
  it('trips once at 3 consecutive errors with one-shot semantics', () => {
    const { ctx, warn } = streakCtx()
    const surface = vi.fn()
    const streak = createErrorStreak({ ctx, surfaceNotices: surface })
    const agent = fakeAgent('a1', 's1')
    for (const _ of [0, 1]) streak.onError(agent, new Error('boom'))
    expect(surface).not.toHaveBeenCalled()
    streak.onError(agent, new Error('boom'))
    expect(surface).toHaveBeenCalledTimes(1)
    const call = surface.mock.calls[0]
    expect(call[0]).toBe('ErrorStreak')
    expect(String(call[1].systemMessages[0])).toContain('3 consecutive API errors this session')
    expect(warn).toHaveBeenCalledTimes(1)
    // One-shot: a 4th error does not re-notice (total 4 < 20).
    streak.onError(agent, new Error('boom'))
    expect(surface).toHaveBeenCalledTimes(1)
  })

  it('a settled turn resets the consecutive count', () => {
    const { ctx } = streakCtx()
    const surface = vi.fn()
    const streak = createErrorStreak({ ctx, surfaceNotices: surface })
    const agent = fakeAgent('a1', 's1')
    streak.onError(agent, new Error('boom'))
    streak.onError(agent, new Error('boom'))
    streak.onTurnSettled(agent, 1)
    streak.onError(agent, new Error('boom'))
    streak.onError(agent, new Error('boom'))
    expect(surface).not.toHaveBeenCalled() // total 4 < 20, consecutive reset
  })

  it('trips the cumulative cap at 20 errors across reset streaks', () => {
    const { ctx } = streakCtx()
    const surface = vi.fn()
    const streak = createErrorStreak({ ctx, surfaceNotices: surface })
    const agent = fakeAgent('a1', 's1')
    // 20 errors in 2-error streaks (consecutive never reaches 3).
    for (let i = 0; i < 10; i++) {
      streak.onError(agent, new Error('boom'))
      streak.onError(agent, new Error('boom'))
      streak.onTurnSettled(agent, i + 1)
    }
    expect(surface).toHaveBeenCalledTimes(1)
    expect(String(surface.mock.calls[0][1].systemMessages[0])).toContain('20 cumulative API errors this session')
  })

  it('honors the consecutive-cap env override', () => {
    process.env.CLAUDE_CODE_AGENT_ERROR_CONSECUTIVE_CAP = '2'
    const { ctx } = streakCtx()
    const surface = vi.fn()
    const streak = createErrorStreak({ ctx, surfaceNotices: surface })
    const agent = fakeAgent('a1', 's1')
    streak.onError(agent, new Error('boom'))
    expect(surface).not.toHaveBeenCalled()
    streak.onError(agent, new Error('boom'))
    expect(surface).toHaveBeenCalledTimes(1)
  })

  it('resets the consecutive count on a real user prompt', () => {
    const { ctx } = streakCtx()
    const surface = vi.fn()
    const streak = createErrorStreak({ ctx, surfaceNotices: surface })
    const agent = fakeAgent('a1', 's1')
    streak.onError(agent, new Error('boom'))
    streak.onError(agent, new Error('boom'))
    streak.onUserPrompt(agent)
    streak.onError(agent, new Error('boom'))
    streak.onError(agent, new Error('boom'))
    expect(surface).not.toHaveBeenCalled()
  })

  it('releaseSession frees the state so a later session can re-trip', () => {
    const { ctx } = streakCtx()
    const surface = vi.fn()
    const streak = createErrorStreak({ ctx, surfaceNotices: surface })
    const agent = fakeAgent('a1', 's1')
    for (const _ of [0, 1, 2]) streak.onError(agent, new Error('boom'))
    expect(surface).toHaveBeenCalledTimes(1)
    streak.releaseSession('s1')
    for (const _ of [0, 1, 2]) streak.onError(agent, new Error('boom'))
    expect(surface).toHaveBeenCalledTimes(2)
  })

  it('wired through the bridge: 3 error turns surface the notice and still run StopFailure per error', async () => {
    const d = dir()
    const sf = recordingStopFailure(d)
    const path = hooks(d, { StopFailure: [{ hooks: [{ type: 'command', command: sf.command }] }] })
    const adapter = new MockAdapter([
      () => { throw new Error('boom') },
      () => { throw new Error('boom') },
      () => { throw new Error('boom') },
    ])
    const ctx = await harness(path, adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const inject = vi.spyOn(agent, 'inject')
    // Plugin-sourced turns: a REAL user prompt resets the consecutive counter
    // by design, so the streak must accumulate across prompt-less turns.
    for (let i = 0; i < 3; i++) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: `go ${i}` }], source: { kind: 'plugin', plugin: 'test' } }))
      await waitForIdle(ctx, agent)
    }
    await waitFor(() => sfLines(sf.flags).length >= 3)
    expect(sfLines(sf.flags)).toHaveLength(3)
    const noticed = inject.mock.calls.flatMap(args => JSON.stringify(args[0])).find(t => t.includes('consecutive API errors this session'))
    expect(noticed).toBeTruthy()
  }, 30_000)
})

describe('A3: output-token continuation', () => {
  function continuationHarness(d: string): { runs: string; command: string } {
    const stop = recordingStop(d)
    return stop
  }

  it('a first ceiling-hit steers the exact continuation text and skips Stop; the recovered completion runs Stop on the next stopping', async () => {
    const d = dir()
    const stop = continuationHarness(d)
    const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command: stop.command }] }] })
    const adapter = new MockAdapter([maxTokensResponse('half'), textResponse('rest done')])
    const ctx = await harness(path, adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    // One continuation step was spliced with the exact CC wording.
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1])).toContain(CONTINUATION_TEXT)
    // The first (max-tokens) stopping skipped Stop; the recovered completion ran it.
    expect(runCount(stop.runs)).toBe(1)
  }, 30_000)

  it('three consecutive ceiling hits steer three times and the fourth stopping runs Stop', async () => {
    const d = dir()
    const stop = continuationHarness(d)
    const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command: stop.command }] }] })
    const adapter = new MockAdapter([
      maxTokensResponse('a'), maxTokensResponse('b'), maxTokensResponse('c'), textResponse('done'),
    ])
    const ctx = await harness(path, adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(4) // 1 original + 3 continuations
    expect(runCount(stop.runs)).toBe(1)
  }, 30_000)

  it('cap 0 disables continuation: the first ceiling stopping runs Stop immediately', async () => {
    process.env.CLAUDE_CODE_OUTPUT_TOKEN_CONTINUATION_CAP = '0'
    const d = dir()
    const stop = continuationHarness(d)
    const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command: stop.command }] }] })
    const adapter = new MockAdapter([maxTokensResponse('cut')])
    const ctx = await harness(path, adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
    expect(runCount(stop.runs)).toBe(1)
  }, 30_000)

  it('a new user-prompt turn resets the chain', async () => {
    process.env.CLAUDE_CODE_OUTPUT_TOKEN_CONTINUATION_CAP = '1'
    const d = dir()
    const stop = continuationHarness(d)
    const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command: stop.command }] }] })
    const adapter = new MockAdapter([
      maxTokensResponse('t1'), textResponse('done1'),
      maxTokensResponse('t2'), textResponse('done2'),
    ])
    const ctx = await harness(path, adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(2) // steer used up the cap-1 chain
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go again' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    // The chain was reset for turn 2, so the ceiling hit steers again.
    expect(adapter.requests).toHaveLength(4)
  }, 30_000)

  it('lastAttemptHitCeiling reads the serialized compact stream finish frame', async () => {
    process.env.CLAUDE_CODE_OUTPUT_TOKEN_CONTINUATION_CAP = '0' // no steering — observe the gate only
    const d = dir()
    const path = hooks(d, {})
    const adapter = new MockAdapter([maxTokensResponse('cut off mid')])
    const ctx = await harness(path, adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    expect(lastAttemptHitCeiling(agent)).toBe(false) // no attempts yet
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(lastAttemptHitCeiling(agent)).toBe(true)
    adapter.script.push(textResponse('recovered'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go on' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(lastAttemptHitCeiling(agent)).toBe(false)
  }, 30_000)

  it('per-agent chain state: two agents in one session continue independently', () => {
    const { ctx } = streakCtx()
    const continuation = createContinuation({ ctx })
    const ceiling = { type: 'assistant/attempt', data: { stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'max-tokens' } } }] } }
    const a1 = fakeAgent('a1', 's1')
    const a2 = fakeAgent('a2', 's1')
    ;(a1.session as unknown as { snapshotEvents: () => unknown[] }).snapshotEvents = () => [ceiling]
    ;(a2.session as unknown as { snapshotEvents: () => unknown[] }).snapshotEvents = () => [ceiling]
    process.env.CLAUDE_CODE_OUTPUT_TOKEN_CONTINUATION_CAP = '1'
    // Caps are resolved at create time; rebuild with the override active.
    const continuation2 = createContinuation({ ctx })
    expect(continuation2.tryContinue(a1, 1)).toBe(true)
    expect(continuation2.tryContinue(a1, 1)).toBe(false) // cap-1 chain consumed for a1
    expect(continuation2.tryContinue(a2, 1)).toBe(true) // a2's own chain
    expect(continuation.tryContinue(fakeAgent('a3', 's1'), 1)).toBe(false) // default cap path unaffected: no ceiling
  })
})
