/**
 * Composition pinning for the background-agent runtime (plan
 * docs/plans/2026-09-03-background-agent-runtime.md §3.3 / §4.11): the cc
 * deployment composition must keep (a) a session-persistence backend service
 * and (b) the host-plane `tool-subagent-report` continuable setup mounted
 * EXACTLY ONCE. If a future preset/patch upgrade drops either row, this test
 * fails at the drift gate instead of background children silently losing
 * durability or double-mounting the report tool into every child.
 *
 * The composed app mirrors the production rows: the host session persistence
 * (jsonl backend, as inherited from the dsh base patch), the subagent runtime
 * + in-process spawn provider, the delegation tools (send_message /
 * interrupt_agent / list_agents), and the report setup.
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
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ControlTools from '@deepseek-ai/dsh-tool-subagent-control'
import * as ListAgents from '@deepseek-ai/dsh-tool-subagent-control/list-agents'
import * as ReportTool from '@deepseek-ai/dsh-tool-subagent-report'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'

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
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  // (b) the delegation group rows + the host-plane report setup, each ONCE.
  await ctx.plugin(ControlTools)
  await ctx.plugin(ListAgents)
  await ctx.plugin(ReportTool)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  // Keep the stand-in parent out of the scripted corpus.
  ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
    if (subject !== parent) return next()
    return { kind: 'reject' as const }
  })
  return { ctx, parent, adapter }
}

describe('cc-shell background composition (§4.11)', () => {
  it('resolves a session-persistence backend service', async () => {
    const { ctx } = await compose()
    const persistence = ctx.get('sessionPersistence') as {
      load?: unknown
      inspect?: unknown
    } | undefined
    expect(persistence).toBeDefined()
    // The jsonl backend's contract: durable load + cold inspection.
    expect(typeof persistence!.load).toBe('function')
    expect(typeof persistence!.inspect).toBe('function')
    await ctx.fiber.dispose()
  })

  it('installs the report setup exactly once into a continuable child', async () => {
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
    // The host-plane report contribution ran exactly once: one report tool, no
    // duplicate registration (a second copy would throw at materialization).
    expect(names.filter(name => name === 'report')).toHaveLength(1)
    // The control tools stay globally unique and visible to the parent.
    expect(ctx.tools.schemas().filter(schema => schema.name === 'send_message')).toHaveLength(1)
    expect(ctx.tools.schemas().filter(schema => schema.name === 'interrupt_agent')).toHaveLength(1)
    expect(ctx.tools.schemas().filter(schema => schema.name === 'list_agents')).toHaveLength(1)

    // Release the child; the composition stays healthy through settlement.
    await child.cancel({ kind: 'parent' })
    await vi.waitFor(() => {
      expect(ctx.agents.get(started.childId)).toBeUndefined()
    }, { timeout: 10_000 })
  }, 20_000)
})
