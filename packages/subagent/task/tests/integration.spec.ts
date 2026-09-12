/**
 * Integration/composition coverage for the CC Task tool's background mode
 * (docs/plans/2026-09-03-background-agent-runtime.md §4.9, §4.10, §4.12, §4.13):
 * the REAL Task plugin composed on a real in-process harness stack (agent loop,
 * jsonl session persistence, subagent runtime + in-process spawn provider,
 * harness control tools), with only the model scripted.
 *
 * These tests fail if the P0 wiring regresses: the durable agentId contract,
 * the control loop, idle-parent wake, cold resume, and parent teardown drain.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ControlTools from '@deepseek-ai/dsh-tool-subagent-control'
import * as ListAgents from '@deepseek-ai/dsh-tool-subagent-control/list-agents'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import { defineTool } from '@dsh-cc/tools'
import { apply as applyTask } from '../src/index.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** A workspace root the parent session is bound to (the Task registry's cwd). */
function workspace(withDefinition = false): string {
  const root = roots[roots.length - 1]!
  const ws = join(root, 'workspace')
  mkdirSync(join(ws, '.claude', 'agents'), { recursive: true })
  if (withDefinition) {
    writeFileSync(
      join(ws, '.claude', 'agents', 'researcher.md'),
      '---\nname: researcher\ndescription: reads things\ntools:\n  - read\n---\nRESEARCHER PERSONA MARKER\n',
    )
  }
  return ws
}

/** A small deployment tool surface so the researcher toolFilter has a target. */
function registerReadTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'read',
    description: 'read',
    parameters: {},
    output: { schema: { type: 'null' }, render: () => [] },
    async execute() { return null },
  }))
}

/**
 * Boot the full composition the cc preset mounts for delegation: harness
 * runtime stack + control tools + the CC Task
 * plugin. The parent is parked by default (its wake pre-steps are counted and
 * rejected), so tests assert on delivery rather than the parent's own turns.
 */
async function setup(
  script: ConstructorParameters<typeof MockAdapter>[0],
  opts: {
    workspace?: boolean
  } = {},
) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-cc-task-integration-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  // The subagent runtime's cold-resume delivery resolves sessions through
  // the session-query engine.
  await ctx.plugin(SessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(ControlTools)
  await ctx.plugin(ListAgents)
  registerReadTool(ctx)
  // The production cc `tools` service is dsh-cc's ToolRuntime, whose `reserve`
  // keeps disabled-row names restrictable; the testkit mounts the harness
  // ToolRuntime, which lacks that extension — add the minimal equivalent so
  // the Task plugin mounts identically.
  const tools = ctx.get('tools') as { reserve?(name: string): () => void }
  if (typeof tools.reserve !== 'function') {
    const reserved = new Set<string>()
    tools.reserve = (name: string) => {
      reserved.add(name)
      return () => { reserved.delete(name) }
    }
  }
  applyTask(ctx)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(
    SessionId('parent'),
    { provider: 'mock', model: 'mock' },
    { cwd: workspace(opts.workspace === true) },
  )
  // Park the parent: its scripted corpus is sized for child turns only. Every
  // wake pre-step is counted, and every message delivered into the parent's
  // inbox (the wake payload) is captured for content assertions.
  let wakes = 0
  const delivered: { source?: string; text: string }[] = []
  ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
    if (subject !== parent) return next()
    wakes += 1
    return { kind: 'reject' as const }
  })
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent !== parent) return
    delivered.push({
      source: (message.source as { kind?: string }).kind,
      text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
    })
  })
  return { ctx, parent, adapter, wakeCount: () => wakes, delivered }
}

/** Read one stored session's header + event log through the rc.1
 * sessionPersistence face (`stat` + a read `open` handle); `undefined` when
 * the session does not exist. */
async function loadStoredSession(persistence: {
  stat(id: SessionId): Promise<unknown>
  open(id: SessionId, access: 'read'): Promise<{ header: SessionHeader; read(): Promise<{ events: readonly SessionEvent[] }>; close(): Promise<void> }>
}, id: SessionId): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] } | undefined> {
  if (await persistence.stat(id) === undefined) return undefined
  const handle = await persistence.open(id, 'read')
  try {
    return { meta: handle.header, events: (await handle.read()).events }
  } finally {
    await handle.close()
  }
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

let calls = 0
function callTool(ctx: Context, name: string, args: unknown, agent: Agent) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++calls}`),
    name,
    arguments: args,
    agent: agent as never,
  })
}

/** Start a durable background child through the REAL Task tool; return its agentId. */
async function startBackground(ctx: Context, parent: Agent, args: Record<string, unknown> = {}): Promise<string> {
  const result = await callTool(ctx, 'subagent_fork', {
    description: 'long research',
    prompt: 'slow work',
    run_in_background: true,
    ...args,
  }, parent)
  if (result.isError) throw new Error(`background Task failed: ${text(result as never)}`)
  const agentId = /agentId: ([0-9a-f-]{36})/.exec(text(result as never))?.[1]
  expect(agentId, `background notice must name the durable id, got: ${text(result as never)}`).toBeTypeOf('string')
  return agentId!
}

/** Wait until a child's Activation is gone (its handle finished disposal). */
async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 10_000 })
}

/** Caller-supplied user message texts in log order (runtime-context snapshots excluded). */
function userTexts(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => event.type === 'user/message' && event.data.source.kind !== 'plugin'
    ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : [])
}

function eventSource(event: SessionEvent): string | undefined {
  return event.type === 'user/message' ? (event.data.source as { kind?: string }).kind : undefined
}

describe('Task background mode — control loop (§4.9)', () => {
  it('returns promptly with the durable id; list_agents enumerates it; interrupt stops the turn; send_message continues it', async () => {
    const { ctx, parent } = await setup(['hang', textResponse('resumed answer')])

    const agentId = await startBackground(ctx, parent)
    const childId = SessionId(agentId)

    // (a) Promptly: the initial turn is STILL running ('hang' blocks) while the
    // tool has already returned — it did not await the child's final text.
    await vi.waitFor(() => {
      const child = ctx.agents.get(childId)
      expect(child).toBeDefined()
      expect(child!.status).toBe('running')
    }, { timeout: 10_000 })

    // (b) list_agents enumerates the child by the returned durable id.
    const list = await callTool(ctx, 'list_agents', {}, parent)
    expect(list.isError).toBe(false)
    expect(text(list as never)).toContain(agentId)
    expect(text(list as never)).toContain('long research')

    // (d) interrupt_agent stops the running turn.
    const child = ctx.agents.get(childId)!
    const cancelSpy = vi.spyOn(child, 'cancel')
    const interrupt = await callTool(ctx, 'interrupt_agent', { agent_id: agentId }, parent)
    expect(interrupt.isError).toBe(false)
    expect(cancelSpy).toHaveBeenCalledExactlyOnceWith({ kind: 'parent' }, { keepInbox: true })
    await vi.waitFor(() => expect(ctx.agents.get(childId)?.status).toBe('idle'), { timeout: 10_000 })

    // (c) send_message by the returned id delivers a follow-up turn.
    const send = await callTool(ctx, 'send_message', { agent_id: agentId, message: 'continue please' }, parent)
    expect(send.isError).toBe(false)
    expect(text(send as never)).toContain(`message delivered to agent ${agentId}`)
    await waitNoActivation(ctx, childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, childId)
    // The delivered follow-up is formatted with the runtime's "Agent <id> sent
    // a message: " prefix; assert the shape, not the exact wrapper (the log
    // may carry additional runtime-context rows around the two caller texts).
    const texts = userTexts(loaded.events)
    // (§8) The prefix is its own content block; assert it lands on the SAME
    // user/message as the caller text, not in one concatenated entry.
    const delivered = loaded.events
      .filter(event => event.type === 'user/message'
        && (event.data.content as { type: string; text?: string }[]).some(
          block => block.type === 'text' && block.text?.includes('sent a message'),
        ))
      .map(event => (event.data.content as { type: string; text?: string }[])
        .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
    expect(texts[0]).toBe('slow work')
    expect(delivered.some(entry => entry.includes('continue please'))).toBe(true)
  }, 20_000)
})

describe('Task background mode — steer-while-running (pin)', () => {
  it('a sendMessage to a RUNNING child steers at the next step boundary (nextStep, not a FIFO turn)', async () => {
    const { ctx, parent } = await setup(['hang', textResponse('never reached')])

    const agentId = await startBackground(ctx, parent)
    const childId = SessionId(agentId)
    await vi.waitFor(() => {
      const child = ctx.agents.get(childId)
      expect(child).toBeDefined()
      expect(child!.status).toBe('running')
    }, { timeout: 10_000 })
    const child = ctx.agents.get(childId)!
    const stepsBefore = child.inbox.nextStep.length

    // The runtime admits the delivery at the child's NEAREST STEP BOUNDARY:
    // it is parked in the running child's nextStep queue, not a FIFO turn.
    const messageId = await ctx.subagents.sendMessage(
      parent,
      childId,
      [{ type: 'text' as const, text: 'steered mid-flight' }],
      { signal: new AbortController().signal },
    )
    expect(typeof messageId).toBe('string')
    expect(child.inbox.nextStep.length).toBe(stepsBefore + 1)
    expect(child.inbox.nextStep.some(message =>
      message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
        .includes('steered mid-flight'))).toBe(true)

    // Release the hung child cleanly.
    await child.cancel({ kind: 'parent' })
    await waitNoActivation(ctx, childId)
  }, 20_000)
})

describe('Task background mode — idle-parent wake (§4.10)', () => {
  it('the parked parent is woken (new turn attempt) by a child send_message, then again at settlement', async () => {
    const { ctx, parent, wakeCount, delivered } = await setup([
      // The child addresses its finding to the parked parent by session id via
      // the harness send_message control tool (the sole child→parent channel).
      toolCallResponse('r1', 'send_message', { agent_id: 'parent', message: 'FINDING: the answer' }),
      textResponse('wrapping up'),
    ])

    const agentId = await startBackground(ctx, parent)
    const childId = SessionId(agentId)

    // The child sends mid-turn; the delivery inserts the message into the
    // idle parent's inbox and starts a wake turn on it (counted by the parked
    // pre-step before it rejects).
    await vi.waitFor(() => {
      expect(delivered.some(entry => entry.source === 'agent-message'
        && entry.text.includes('FINDING: the answer'))).toBe(true)
      expect(wakeCount()).toBeGreaterThanOrEqual(1)
    }, { timeout: 10_000 })

    // The child settles; the runtime's finish notice wakes the parent again.
    await waitNoActivation(ctx, childId)
    await vi.waitFor(() => {
      expect(delivered.some(entry => entry.source === 'subagent-settled'
        && entry.text.includes('Background subagent'))).toBe(true)
      expect(wakeCount()).toBeGreaterThanOrEqual(2)
    }, { timeout: 10_000 })
  }, 20_000)
})

describe('Task background mode — cold resume (§4.12)', () => {
  it('re-materializes a parked child from the persisted Session with persona and toolFilter intact', async () => {
    const { ctx, parent, adapter } = await setup(
      [textResponse('first answer'), textResponse('resumed answer')],
      { workspace: true },
    )

    const agentId = await startBackground(ctx, parent, { subagent_type: 'researcher' })
    const childId = SessionId(agentId)
    await waitNoActivation(ctx, childId)
    expect(await loadStoredSession(ctx.sessionPersistence, childId)).toBeDefined()

    // send_message cold-resumes: a new Activation materializes from the
    // persisted session (no live handle existed before the delivery).
    expect(ctx.agents.get(childId)).toBeUndefined()
    const send = await callTool(ctx, 'send_message', { agent_id: agentId, message: 'keep going' }, parent)
    expect(send.isError).toBe(false)
    expect(text(send as never)).toContain(`message delivered to agent ${agentId}`)
    await vi.waitFor(() => {
      expect(adapter.requests.filter(request => request.sessionId === childId).length).toBeGreaterThanOrEqual(2)
    }, { timeout: 10_000 })

    // The descriptor composition survived: the resumed child still carries the
    // definition's persona and its sanitized (allow: [read]) tool filter.
    const resumed = adapter.requests.filter(request => request.sessionId === childId).at(-1)!
    // 0.1.5: the system prompt rides as the leading system message, not a request field.
    expect(JSON.stringify(resumed.messages?.filter((message: { role: string }) => message.role === 'system'))).toContain('RESEARCHER PERSONA MARKER')
    const toolNames = (resumed.tools ?? []).map(tool => tool.name)
    expect(toolNames).toContain('read')
    expect(toolNames).not.toContain('write')

    await waitNoActivation(ctx, childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, childId)
    // Shape assertion (§8): the runtime's "Agent <id> sent a message: " prefix
    // is its own content block on the same user/message as the caller's text.
    const texts = userTexts(loaded.events)
    const delivered = loaded.events
      .filter(event => event.type === 'user/message'
        && (event.data.content as { type: string; text?: string }[]).some(
          block => block.type === 'text' && block.text?.includes('sent a message'),
        ))
      .map(event => (event.data.content as { type: string; text?: string }[])
        .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
    expect(texts[0]).toBe('slow work')
    expect(delivered.some(entry => entry.includes('keep going'))).toBe(true)
  }, 20_000)
})

describe('Task background mode — parent teardown drain (§4.13)', () => {
  it("stops the child's Activation and its persisted Session survives", async () => {
    const { ctx, parent } = await setup(['hang', textResponse('after drain')])

    const agentId = await startBackground(ctx, parent)
    const childId = SessionId(agentId)
    await vi.waitFor(() => expect(ctx.agents.get(childId)).toBeDefined(), { timeout: 10_000 })

    // The parent-teardown release path for one durable direct child
    // (drainContinuableChildren — the per-child arm of the teardown drain).
    await ctx.subagents.drainContinuableChildren(parent, [childId])

    // The in-flight turn was stopped and the Activation released…
    await waitNoActivation(ctx, childId)
    // …but nothing was lost: the persisted Session survives (the interrupted
    // initial prompt remains durable as an inbox splice on the child's log).
    const loaded = await loadStoredSession(ctx.sessionPersistence, childId)
    expect(String(loaded.meta.id)).toBe(String(childId))
    expect(JSON.stringify(loaded.events)).toContain('slow work')
  }, 20_000)

  it('keeps a DRAINING cutoff until the parent leaves the registry (full-forest arm)', async () => {
    const { ctx, parent } = await setup(['hang'])

    const agentId = await startBackground(ctx, parent)
    const childId = SessionId(agentId)
    await vi.waitFor(() => expect(ctx.agents.get(childId)).toBeDefined(), { timeout: 10_000 })

    // The whole-forest drain (what a session teardown runs) closes the parent
    // itself: continuation from the still-live drained parent is refused with
    // DRAINING — callers must let the parent leave the registry (session
    // dispose + resume/restart) before continuing a drained child.
    await ctx.subagents.drainContinuableDescendants([parent])
    await waitNoActivation(ctx, childId)
    await expect(ctx.subagents.sendMessage(parent, childId,
      [{ type: 'text' as const, text: 'too early' }],
      { signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'DRAINING' })
    const loaded = await loadStoredSession(ctx.sessionPersistence, childId)
    expect(String(loaded.meta.id)).toBe(String(childId))
  }, 20_000)

  // SKIPPED (re-probed at 0.1.5-rc.1): the final §4.13 leg — `send_message`
  // cold-resuming a child whose Activation was torn down by
  // `drainContinuableChildren` — still does not complete end to end. Progress
  // since 0.1.2-rc.1: the delivery seam was reworked (deliverToChild /
  // steerPrompt, continuation-messages.ts) and the send now RESOLVES — no
  // DRAINING error from assertAdmitting on the per-child arm (the parent is
  // not itself drained), even with the child fully out of the registry
  // (ctx.agents.get(childId) === undefined awaited before the send). But the
  // cold-resumed Activation never issues a model call: the scripted adapter
  // records only the initial request (1, never ≥2) within 10s — the same
  // "Activation never re-materializes into a turn" gap reproduced at 0.1.2.
  // Natural-settle cold resume works (pinned by the §4.12 test above).
  it.skip('a later send_message cold-resumes the drained child from its persisted Session', () => {})
})
