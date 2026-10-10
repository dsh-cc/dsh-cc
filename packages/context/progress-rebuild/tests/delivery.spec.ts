import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import { defineContentToolFixture } from '@dsh-cc/tools'
import * as Plugin from '../src/index.ts'

/**
 * REAL composition specs (compaction-cost-gate composition pattern): the REAL
 * progress-rebuild plugin runs against the REAL agent loop with a scripted
 * mock MODEL — only the model and (implicitly) the compaction backend are
 * stubbed: the compaction lifecycle is driven by durable log events appended
 * directly, exactly as the engine would record them.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const BRIEF_MARK = 'Resume after compaction (auto-generated, derived from session events'

interface RigOptions {
  enabled: boolean
  /** Owner recorded on the appended compaction triple. */
  turn: number | null
  /** Whether the appended compaction/end carries an error field. */
  failed?: boolean
}

/** Append a VALID compaction/start → summary → end triple on one session. */
function appendCompactionTriple(session: { append(type: string, data: object): unknown }, turn: number | null, failed?: boolean): void {
  const provenance = { compactionId: CompactionId('pr-compaction-1'), turn }
  session.append('compaction/start', provenance)
  session.append('compaction/summary', {
    ...provenance,
    summary: [{ type: 'text', text: 'summary of the shadowed range' }] as ContentBlock[],
    shadowedRange: { start: 1, end: 2 },
    shadowedSeqs: [1, 2],
    shadowedTokenCount: 12,
    provider: 'mock',
    model: 'mock',
  })
  session.append('compaction/end', failed === true ? { ...provenance, error: 'summarizer failed' } : provenance)
}

async function build(adapter: MockAdapter, options: RigOptions): Promise<{ ctx: Context; agent: Agent; rows: unknown[] }> {
  const home = mkdtempSync(join(tmpdir(), 'pr-delivery-'))
  dirs.push(home)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  void new TokenMeter(ctx)
  ctx.tools.register(defineContentToolFixture({
    name: 'compact_now',
    description: 'append the compaction lifecycle triple, as the engine would',
    parameters: {},
    async execute(_args, exec) {
      const session = exec.agent!.session
      appendCompactionTriple(session, options.turn, options.failed)
      return [{ type: 'text', text: 'compaction recorded' }]
    },
  }))
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(Plugin, {
    readSettings: () => ({ enabled: options.enabled, maxLines: 120, includeVerified: true }),
  })
  // Subscribe BEFORE agent creation: session events dispatch to the session's
  // captured emit scope, so late subscribers see nothing.
  const rows: unknown[] = []
  ctx.on('session/event', (_session, event: SessionEvent) => {
    if (String(event.type) === Plugin.PROGRESS_REBUILD_INJECTED_EVENT) {
      rows.push(event.data as unknown)
    }
  })
  const agent = await ctx.agentLoop.create(SessionId('pr-root'), { provider: 'mock', model: 'mock' })
  return { ctx, agent, rows }
}


function requestTexts(adapter: MockAdapter, index: number): string[] {
  const messages = adapter.requests[index]?.messages as
    | readonly { content?: readonly { type?: unknown; text?: unknown }[] }[]
    | undefined
  return (messages ?? []).flatMap((message) =>
    (message.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string),
  )
}

describe('progress-rebuild delivery (real loop, §5.3)', () => {
  it('(a) in-turn end: the FIRST request after compaction/end carries the brief (pre-step splice)', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'compact_now', {}),
      textResponse('resumed'),
    ])
    const { agent } = await build(adapter, { enabled: true, turn: 1 })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests.length).toBeGreaterThanOrEqual(2)
    expect(requestTexts(adapter, 1).some((text) => text.includes(BRIEF_MARK))).toBe(true)
    expect(requestTexts(adapter, 0).some((text) => text.includes(BRIEF_MARK))).toBe(false)
  })

  it('(b) idle end (turn: null) → deferred inject lands in inbox.nextStep and rides the next turn', async () => {
    const adapter = new MockAdapter([
      textResponse('hello'),
      textResponse('after compaction'),
    ])
    const { agent, rows } = await build(adapter, { enabled: true, turn: null })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // Idle compaction while the agent is idle: the DEFERRED inject lands.
    appendCompactionTriple(agent.session, null)
    await new Promise((r) => setTimeout(r, 20))
    expect(agent.inbox.nextStep.some((message) =>
      message.content.some((block) => block.type === 'text' && String((block as { text?: unknown }).text).includes(BRIEF_MARK)),
    )).toBe(true)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(requestTexts(adapter, 1).some((text) => text.includes(BRIEF_MARK))).toBe(true)
    expect(rows.length).toBeGreaterThanOrEqual(1)
  })

  it('(c) failed end (error field) → no brief, no measurement event', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'compact_now', {}),
      textResponse('done'),
    ])
    const { agent, rows } = await build(adapter, { enabled: true, turn: 1, failed: true })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(requestTexts(adapter, 1).some((text) => text.includes(BRIEF_MARK))).toBe(false)
    expect(rows).toHaveLength(0)
  })

  it('(d) measurement progress-rebuild/injected lands only after successful delivery', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'compact_now', {}),
      textResponse('resumed'),
    ])
    const { agent, rows } = await build(adapter, { enabled: true, turn: 1 })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await new Promise((r) => setTimeout(r, 20))

    expect(rows.length).toBe(1)
    const payload = rows[0] as { bytes: number; sections: number; path: string }
    expect(payload.path).toBe('pre-step')
    expect(payload.bytes).toBeGreaterThan(0)
    expect(payload.sections).toBeGreaterThanOrEqual(1)
  })

  it('(e) enabled=false → no delivery at all', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'compact_now', {}),
      textResponse('done'),
    ])
    const { agent, rows } = await build(adapter, { enabled: false, turn: 1 })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(requestTexts(adapter, 1).some((text) => text.includes(BRIEF_MARK))).toBe(false)
    expect(rows).toHaveLength(0)
  })

  it('(f) the ACK observer fires only on COMMITTED progress-rebuild user/message events', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'compact_now', {}),
      textResponse('resumed'),
    ])
    const { agent, rows } = await build(adapter, { enabled: true, turn: 1 })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const deliveredRows = rows.length
    expect(deliveredRows).toBeGreaterThanOrEqual(1) // (d): the spliced brief was acknowledged

    // A plain user/message appended by a DIFFERENT mechanism (no source kind,
    // like a restore-style replay row) does NOT re-trigger the measurement.
    agent.session.append('user/message', {
      id: 'm-plain-1',
      role: 'user',
      content: [{ type: 'text', text: `${BRIEF_MARK} plain` }],
    } as never, { surfaceOp: 'append' } as never)
    await new Promise((r) => setTimeout(r, 20))
    expect(rows.length).toBe(deliveredRows)
  })
})

describe('wiring (recovery-wiring.spec idiom, fake ctx)', () => {
  function fakeRig(): { ctx: { on: ReturnType<typeof vi.fn>; get: (key: string) => unknown; logger: { debug: ReturnType<typeof vi.fn> } }; calls: [string, unknown][] } {
    const calls: [string, unknown][] = []
    const ctx = {
      logger: { debug: vi.fn() },
      get: (key: string) => (key === 'sessionProjections' ? { register: () => {} } : undefined),
      on: vi.fn((event: string, handler: unknown) => {
        calls.push([event, handler] as unknown as [string, unknown])
        return () => {}
      }),
    }
    Plugin.apply(ctx as never)
    return { ctx, calls }
  }

  it('apply() registers exactly the three delivery listeners when sessionProjections is present', () => {
    const { calls } = fakeRig()
    const events = calls.map(([event]) => event)
    expect(events.filter((e) => e === 'session/event')).toHaveLength(2)
    expect(events.filter((e) => e === 'agent/pre-step')).toHaveLength(1)
    expect(events.filter((e) => e === 'session/disposed')).toHaveLength(1)
  })

  it('agents registry absent → compaction/end degrades to a debug no-op (no throw)', () => {
    const { calls } = fakeRig()
    const listenerB = calls.find(([event, handler]) =>
      event === 'session/event' && typeof handler === 'function')![1] as
      (session: unknown, event: unknown) => void
    const fakeSession = {
      header: { id: SessionId('pr-wiring') },
      append: () => {},
    }
    expect(() => listenerB(fakeSession, { type: 'compaction/end', seq: 1, time: 1, data: { compactionId: 'c', turn: null } })).not.toThrow()
  })
})
