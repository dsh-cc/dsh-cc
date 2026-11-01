/**
 * Integration canary (Staff M1) for the alias-stamped reasoning effort: a real
 * cordis context, the cc-model-aliases routes service mounted (its host
 * `agent/request` overlay listener included), a mock llm adapter, and real
 * in-process child agents driven through the subagent seam. The adapter must
 * observe `config.reasoningEffort` on the stamped child's request — the
 * contract that breaks if the harness ever strips unknown `AgentOptions` keys
 * or changes scope admission for host listeners.
 *
 * Also pins the nested-child behavior at the 0.1.3 pin: a grandchild spawned
 * WITHOUT agentOptions inherits its same-route parent's route state
 * (provider/model/reasoningEffort — upstream's resolveChildAgentOptions now
 * forwards the parent's route-owned effort); and a same-route fork child MAY
 * restore the parent's explicit header effort from the seed before the
 * overlay wins — accepted, not a new copy path.
 *
 * Pattern follows packages/subagent/coordinator/tests/coordinator.spec.ts.
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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import { apply as applyModelAliases } from '../src/index.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

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

/** Mount the real agent-loop stack + the routes service under one context. */
async function setup(script: ConstructorParameters<typeof MockAdapter>[0]): Promise<{
  ctx: Context
  adapter: MockAdapter
  parent: Agent
  subagents: SubagentsSeam
}> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const root = mkdtempSync(join(tmpdir(), 'dsh-alias-effort-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  // Advertise the reasoning levels the tests stamp, so the mock's
  // UNSUPPORTED_REASONING_EFFORT gate does not fire (that gate is exercised by
  // the adapters' own suites).
  const reasoning: LlmModelReasoningInfo = {
    efforts: [
      { id: 'off', name: 'off' },
      { id: 'high', name: 'high' },
      { id: 'max', name: 'max' },
      { id: 'xhigh', name: 'xhigh' },
    ],
  }
  const adapter = new MockAdapter(script, reasoning)
  ctx.llm.registerAdapter(['mock'], adapter)
  // The routes service mounts no aliases here — what matters is its host
  // `agent/request` overlay listener being registered by apply().
  applyModelAliases(ctx, {})
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, adapter, parent, subagents: ctx.get('subagents') as SubagentsSeam }
}

const signal = new AbortController().signal

describe('alias-stamped reasoningEffort reaches the model request (integration)', () => {
  it('a spawned child with a stamped agentOptions requests with that effort (M1 canary)', async () => {
    const { adapter, parent, subagents } = await setup([textResponse('child done')])
    const run = await subagents.startActivation({
      provider: 'spawn',
      label: 'stamped-child',
      request: {
        prompt: [{ type: 'text', text: 'work' }],
        parent,
        agentOptions: { provider: 'mock', model: 'glm-5.3', reasoningEffort: 'max' },
        maxDepth: 3,
      },
      signal,
      delivery: 'caller',
    })
    const settled = await run.result
    expect(settled.stopReason).toBe('completed')
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({
      provider: 'mock',
      model: 'glm-5.3',
      reasoningEffort: 'max',
    })
  })

  it('a child without a stamp requests without an effort (no overlay, no leak)', async () => {
    const { adapter, parent, subagents } = await setup([textResponse('plain child')])
    const run = await subagents.startActivation({
      provider: 'spawn',
      label: 'plain-child',
      request: {
        prompt: [{ type: 'text', text: 'work' }],
        parent,
        agentOptions: { provider: 'mock', model: 'glm-5.3' },
      },
      signal,
      delivery: 'caller',
    })
    await run.result
    expect(adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'glm-5.3' })
    expect(adapter.requests[0]).not.toHaveProperty('reasoningEffort')
  })

  it('the overlay beats a restored fork-seed header effort', async () => {
    const { adapter, parent, subagents } = await setup([
      textResponse('parent turn'),
      textResponse('fork child turn'),
    ])
    // Give the parent one completed turn whose header carries an explicit
    // effort: a test-scoped listener stamps 'high' onto the PARENT's requests
    // only, mirroring an explicit parent-side /effort.
    const dispose = parent.ctx.on('agent/request', async (payload: unknown, next: () => Promise<Record<string, unknown>>) => {
      const resolved = await next()
      return { ...resolved, reasoningEffort: 'high' }
    })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    dispose()

    // A fork child on the SAME route (mock/mock) restores 'high' from the seed
    // header — the alias stamp 'max' must win on the wire.
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
    const settled = await run.result
    expect(settled.stopReason).toBe('completed')
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]).toMatchObject({ model: 'mock', reasoningEffort: 'high' })
    expect(adapter.requests[1]).toMatchObject({ model: 'mock', reasoningEffort: 'max' })
  })

  it('a grandchild spawned without agentOptions inherits the same-route effort (upstream >=0.1.3 semantics)', async () => {
    // rc.5: the child's live Agent must be looked up while it is still
    // resident (a settled child leaves the registry), so it hangs until its
    // turn is disposed; the grandchild runs on the next script entry.
    const { ctx, adapter, parent, subagents } = await setup([
      'hang' as never,
      textResponse('grandchild'),
    ])
    const child = await subagents.startActivation({
      provider: 'spawn',
      label: 'stamped-parent-of-grandchild',
      request: {
        prompt: [{ type: 'text', text: 'work' }],
        parent,
        agentOptions: { provider: 'mock', model: 'glm-5.3', reasoningEffort: 'max' },
        maxDepth: 3,
      },
      signal,
      delivery: 'caller',
    })
    // Continuable by construction here (not disposed): the child stays
    // resident mid-turn as the grandchild's parent. rc.5: no localAgent on
    // the activation — the live child Agent resolves through the registry.
    const childAgent = ctx.agents.get(child.childId)
    expect(childAgent).toBeDefined()

    const grandchild = await subagents.startActivation({
      provider: 'spawn',
      label: 'grandchild',
      request: {
        prompt: [{ type: 'text', text: 'nested work' }],
        parent: childAgent!,
        maxDepth: 3,
      },
      signal,
      delivery: 'caller',
    })
    await grandchild.result
    expect(adapter.requests).toHaveLength(2)
    // Harness >=0.1.3: resolveChildAgentOptions forwards the parent's
    // route-owned reasoningEffort to same-route children (a route change
    // without an explicit requested effort clears it instead). The stamped
    // child runs mock/glm-5.3 with 'max', so the same-route grandchild
    // inherits that route state — the stamp itself is still never COPIED as
    // an unknown key; it arrives through upstream's own inheritance rule.
    expect(adapter.requests[1]).toMatchObject({
      provider: 'mock',
      model: 'glm-5.3',
      reasoningEffort: 'max',
    })
    await child.dispose().catch(() => {})
  })
})
