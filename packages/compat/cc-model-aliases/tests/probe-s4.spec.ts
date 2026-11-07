/**
 * D3.6 upstream-behavior pin (the S4 probe, kept green): WITHOUT the routes
 * service mounted, a fork-seed child whose parent carries an explicit durable
 * effort reports the RESTORED header effort under `AgentModel.current()` —
 * the options stamp is shadowed by the seeded log prefix. This is the probe
 * that killed the "options-effort survives by itself" hypothesis and forced
 * the spawn-path select in service.ts (covered end-to-end by
 * integration.spec.ts). If a future harness makes options win, this spec
 * turns red and the spawn-path select becomes redundant (delete it then).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const signal = new AbortController().signal

interface SubagentsSeam {
  startActivation(spec: {
    provider: string
    label: string
    request: {
      prompt: readonly { type: 'text'; text: string }[]
      parent: Agent
      agentOptions?: Record<string, string>
      maxDepth?: number
    }
    signal: AbortSignal
    delivery: 'parent' | 'caller'
  }): Promise<{ childId: string; result: Promise<{ stopReason: string }>; dispose(): Promise<void> }>
}

/** The bare agent-loop stack — deliberately NO routes service (probe surface). */
async function setup(script: ConstructorParameters<typeof MockAdapter>[0]): Promise<{
  ctx: Context
  adapter: MockAdapter
  parent: Agent
  subagents: SubagentsSeam
}> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const root = mkdtempSync(join(tmpdir(), 'dsh-alias-probe-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  const reasoning: LlmModelReasoningInfo = {
    efforts: [
      { id: 'off', name: 'off' },
      { id: 'high', name: 'high' },
      { id: 'max', name: 'max' },
    ],
  }
  const adapter = new MockAdapter(script, reasoning)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, adapter, parent, subagents: ctx.get('subagents') as SubagentsSeam }
}

describe('fork-seed effort restoration (D3.6 probe surface)', () => {
  it('a fork-seed child reports the restored parent effort, not the options stamp (restoration still occurs)', async () => {
    const { ctx, adapter, parent, subagents } = await setup([textResponse('parent turn')])
    parent.model.select({ provider: 'mock', model: 'mock', reasoningEffort: ReasoningEffortId('high') })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    expect(adapter.requests[0]).toMatchObject({ model: 'mock', reasoningEffort: 'high' })

    const run = await subagents.startActivation({
      provider: 'fork',
      label: 'fork-child',
      request: {
        prompt: [{ type: 'text', text: 'inherited work' }],
        parent,
        agentOptions: { provider: 'mock', model: 'mock', reasoningEffort: 'max' },
        maxDepth: 3,
      },
      signal,
      delivery: 'caller',
    })
    const child = ctx.agents.get(SessionId(run.childId))
    // The probe finding: the seeded request/header (with 'high') wins over the
    // stamped options effort — the request-time overlay was NOT a no-op, so
    // D3.6's spawn-path select (integration.spec.ts) is load-bearing.
    expect(child?.model.current()).toMatchObject({ provider: 'mock', model: 'mock', reasoningEffort: 'high' })
    await run.dispose().catch(() => {})
  })

  it('a plain spawn child keeps the options stamp (options honored with no recorded selection)', async () => {
    const { ctx, parent, subagents } = await setup([])
    const run = await subagents.startActivation({
      provider: 'spawn',
      label: 'spawn-child',
      request: {
        prompt: [{ type: 'text', text: 'fresh work' }],
        parent,
        agentOptions: { provider: 'mock', model: 'mock', reasoningEffort: 'max' },
        maxDepth: 3,
      },
      signal,
      delivery: 'caller',
    })
    const child = ctx.agents.get(SessionId(run.childId))
    expect(child?.model.current()).toMatchObject({ provider: 'mock', model: 'mock', reasoningEffort: 'max' })
    await run.dispose().catch(() => {})
  })
})
