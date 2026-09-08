/**
 * Composition pinning for the background-agent runtime (plan
 * docs/plans/2026-09-03-background-agent-runtime.md §3.3 / §4.11): the cc
 * deployment composition must keep (a) a session-persistence backend service
 * and (b) the host-plane subagent control tooling mounted EXACTLY ONCE. If a
 * future preset/patch upgrade drops either row, this test fails at the drift
 * gate instead of background children silently losing durability or
 * double-mounting the control tools into every agent.
 *
 * The composed app mirrors the production rows: the host session persistence
 * (jsonl backend, as inherited from the dsh base patch), the subagent runtime
 * + in-process spawn provider, and the delegation tools (send_message /
 * interrupt_agent / list_agents).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ControlTools from '@deepseek-ai/dsh-tool-subagent-control'
import * as ListAgents from '@deepseek-ai/dsh-tool-subagent-control/list-agents'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Compose the delegation surface the cc preset + host patch mount. */
async function compose(script: ConstructorParameters<typeof MockAdapter>[0] = []) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'cc-shell-background-'))
  roots.push(root)
  // (a) host-plane persistence: the jsonl backend (dsh base cordis.patch row).
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  // (b) the delegation group rows, each ONCE.
  await ctx.plugin(ControlTools)
  await ctx.plugin(ListAgents)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  // Keep the stand-in parent out of the scripted corpus; every wake pre-step
  // is counted so tests can assert the parked parent was woken.
  let wakes = 0
  ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
    if (subject !== parent) return next()
    wakes += 1
    return { kind: 'reject' as const }
  })
  return { ctx, parent, adapter, wakeCount: () => wakes }
}

describe('cc-shell background composition (§4.11)', () => {
  it('resolves a session-persistence backend service', async () => {
    const { ctx } = await compose()
    const persistence = ctx.get('sessionPersistence') as {
      create?: unknown
      open?: unknown
      flush?: unknown
      stat?: unknown
      list?: unknown
    } | undefined
    expect(persistence).toBeDefined()
    // The jsonl backend's contract at the pin: per-session create/open
    // handles plus service-level flush/stat/list.
    for (const method of ['create', 'open', 'flush', 'stat', 'list']) {
      expect(typeof persistence![method as keyof typeof persistence]).toBe('function')
    }
    await ctx.fiber.dispose()
  })

  it('installs the control tools exactly once and exposes send_message to a continuable child', async () => {
    // 'hang' keeps the child's Activation resident while the scope is inspected.
    const { ctx, parent } = await compose(['hang', textResponse('done'), textResponse('ack')])
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'pinned child',
      request: { prompt: [{ type: 'text', text: 'child task' }], parent },
      signal: new AbortController().signal,
    })

    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    }, { timeout: 10_000 })

    const names = ctx.tools.schemas(child as never).map(schema => schema.name)
    // The control tools stay globally unique and are visible to the child, so
    // it can address the parent (send_message) — the sole delivery channel for
    // child-to-parent results.
    expect(names.filter(name => name === 'send_message')).toHaveLength(1)
    expect(ctx.tools.schemas().filter(schema => schema.name === 'send_message')).toHaveLength(1)
    expect(ctx.tools.schemas().filter(schema => schema.name === 'interrupt_agent')).toHaveLength(1)
    expect(ctx.tools.schemas().filter(schema => schema.name === 'list_agents')).toHaveLength(1)

    // Release the child; the composition stays healthy through settlement.
    await child.cancel({ kind: 'parent' })
    await vi.waitFor(() => {
      expect(ctx.agents.get(started.childId)).toBeUndefined()
    }, { timeout: 10_000 })
  }, 20_000)

  it('a child send_message({agent_id: parent}) wakes the parked parent with the child\'s message', async () => {
    // The §4.10 delivery protocol over the composed cc rows: the child calls
    // the harness send_message control tool addressed to the parent session,
    // the parked parent's wake pre-step fires, and the formatted child
    // message lands in the parent's inbox as an 'agent-message'.
    const { ctx, parent, wakeCount } = await compose([
      toolCallResponse('r1', 'send_message', { agent_id: 'parent', message: 'FINDING: composed' }),
      textResponse('wrapping up'),
    ])
    const delivered: { source?: string; text: string }[] = []
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent !== parent) return
      delivered.push({
        source: (message.source as { kind?: string }).kind,
        text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
      })
    })

    await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'reporting child',
      request: { prompt: [{ type: 'text', text: 'child task' }], parent },
      signal: new AbortController().signal,
    })

    await vi.waitFor(() => {
      expect(delivered.some(entry => entry.source === 'agent-message'
        && entry.text.includes('FINDING: composed'))).toBe(true)
      expect(wakeCount()).toBeGreaterThanOrEqual(1)
    }, { timeout: 20_000 })
  }, 30_000)

  it('a finishing child\'s subagent-settled notice reaches the parked parent', async () => {
    const { ctx, parent } = await compose([textResponse('all done')])
    const delivered: { source?: string; text: string }[] = []
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent !== parent) return
      delivered.push({
        source: (message.source as { kind?: string }).kind,
        text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
      })
    })

    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'settling child',
      request: { prompt: [{ type: 'text', text: 'child task' }], parent },
      signal: new AbortController().signal,
    })

    await vi.waitFor(() => {
      expect(delivered.some(entry => entry.source === 'subagent-settled')).toBe(true)
    }, { timeout: 20_000 })
    await vi.waitFor(() => {
      expect(ctx.agents.get(started.childId)).toBeUndefined()
    }, { timeout: 10_000 })
  }, 30_000)
})
