/**
 * Integration/composition coverage for the CC Task tool's background mode
 * (docs/plans/2026-09-03-background-agent-runtime.md §4.9, §4.10, §4.12, §4.13):
 * the REAL Task plugin composed on a real in-process harness stack (agent loop,
 * jsonl session persistence, subagent runtime + in-process spawn provider,
 * harness control tools and the report setup), with only the model scripted.
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
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ControlTools from '@deepseek-ai/dsh-tool-subagent-control'
import * as ListAgents from '@deepseek-ai/dsh-tool-subagent-control/list-agents'
import * as ReportTool from '@deepseek-ai/dsh-tool-subagent-report'
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
 * runtime stack + control tools + the report continuable setup + the CC Task
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
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(ControlTools)
  await ctx.plugin(ListAgents)
  await ctx.plugin(ReportTool)
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
  const parent = ctx.agentLoop.create(
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
    const send = await callTool(ctx, 'send_message', { subagent_id: agentId, message: 'continue please' }, parent)
    expect(send.isError).toBe(false)
    await waitNoActivation(ctx, childId)
    const loaded = await ctx.sessionPersistence.load(childId)
    expect(userTexts(loaded.events)).toEqual(['slow work', 'continue please'])
  }, 20_000)
})

describe('Task background mode — idle-parent wake (§4.10)', () => {
  it('the parked parent is woken (new turn attempt) with the report content, then again at settlement', async () => {
    const { ctx, parent, wakeCount, delivered } = await setup([
      toolCallResponse('r1', 'report', { output: 'FINDING: the answer' }),
      textResponse('wrapping up'),
    ])

    const agentId = await startBackground(ctx, parent)
    const childId = SessionId(agentId)

    // The child reports mid-turn; the next-step delivery inserts the report
    // into the idle parent's inbox and starts a wake turn on it (counted by
    // the parked pre-step before it rejects).
    await vi.waitFor(() => {
      expect(delivered.some(entry => entry.source === 'subagent-report'
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
    expect(await ctx.sessionPersistence.load(childId)).toBeDefined()

    // send_message cold-resumes: a new Activation materializes from the
    // persisted session (no live handle existed before the delivery).
    expect(ctx.agents.get(childId)).toBeUndefined()
    const send = await callTool(ctx, 'send_message', { subagent_id: agentId, message: 'keep going' }, parent)
    expect(send.isError).toBe(false)
    await vi.waitFor(() => {
      expect(adapter.requests.filter(request => request.sessionId === childId).length).toBeGreaterThanOrEqual(2)
    }, { timeout: 10_000 })

    // The descriptor composition survived: the resumed child still carries the
    // definition's persona and its sanitized (allow: [read]) tool filter.
    const resumed = adapter.requests.filter(request => request.sessionId === childId).at(-1)!
    expect(resumed.system).toContain('RESEARCHER PERSONA MARKER')
    const toolNames = (resumed.tools ?? []).map(tool => tool.name)
    expect(toolNames).toContain('read')
    expect(toolNames).not.toContain('write')

    await waitNoActivation(ctx, childId)
    const loaded = await ctx.sessionPersistence.load(childId)
    expect(userTexts(loaded.events)).toEqual(['slow work', 'keep going'])
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
    const loaded = await ctx.sessionPersistence.load(childId)
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
    await expect(ctx.subagents.followup(parent, childId,
      [{ type: 'text' as const, text: 'too early' }],
      { source: { kind: 'user' as const }, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'DRAINING' })
    const loaded = await ctx.sessionPersistence.load(childId)
    expect(String(loaded.meta.id)).toBe(String(childId))
  }, 20_000)

  // SKIPPED: the final §4.13 leg — `send_message` cold-resuming a child whose
  // Activation was torn down by a drain — is not implementable against the
  // current harness build: `followup` after `drainContinuableChildren` resolves
  // the delivery but the child's Activation never re-materializes (reproduced
  // with the pure harness API, no dsh-cc code involved; in the settled variant
  // no Activation appears at all, in the aborted-turn variant one materializes
  // 'running' but never issues a model call). Only the natural-settle cold
  // resume works (pinned by the §4.12 test above). Harness-side gap.
  it.skip('a later send_message cold-resumes the drained child from its persisted Session', () => {})
})
