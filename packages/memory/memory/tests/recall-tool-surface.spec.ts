/**
 * Tool-surface tripwire (W3): the memory-recall fork child's EFFECTIVE tool
 * surface, observed the only way there is — the mock adapter's captured model
 * request, whose `tools` array is the post-`restrict()` surface the child's
 * loop actually saw. There is no public tool-enumeration API.
 *
 * Invariant under test: with `toolFilter: RECALL_TOOL_FILTER`
 * ({ allow: ['read'] }), every visible tool is `read` or the own-layer
 * `structured_output` reporting tool, and BOTH are present (a filter that
 * strips the reporting machinery or the read channel is itself a regression).
 *
 * Negative control: the identical fork WITHOUT the toolFilter must surface a
 * strictly larger tool set — otherwise the invariant could pass vacuously on
 * an empty/unaltered surface.
 *
 * Pattern: packages/compat/cc-model-aliases/tests/integration.spec.ts.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import { MockAdapter, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import { defineTool } from '@dsh-cc/tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { RECALL_FILES_SCHEMA, RECALL_TOOL_FILTER } from '../src/recall.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

interface SubagentsSeam {
  start(name: string, request: {
    label?: string
    prompt: readonly { type: 'text'; text: string }[]
    parent: Agent
    signal: AbortSignal
    toolFilter?: { allow: readonly string[] }
    outputSchema?: Record<string, unknown>
    maxDepth?: number
  }): Promise<{ result: Promise<{ stopReason: string }> }>
}

/** Mount the real agent-loop stack + the in-process fork provider (no routes service needed — no alias overlay here). */
async function setup(): Promise<{
  adapter: MockAdapter
  parent: Agent
  subagents: SubagentsSeam
}> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-recall-surface-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  // Global tool surface: `read` is the RECALL_TOOL_FILTER target; a second
  // global makes the negative control strictly larger than the filtered set.
  for (const name of ['read', 'grep'] as const) {
    ctx.tools.register(defineTool({
      name,
      description: name,
      parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      async execute() { return null },
    }))
  }
  const adapter = new MockAdapter([toolCallResponse('c1', 'structured_output', { files: [] })])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { adapter, parent, subagents: ctx.get('subagents') as SubagentsSeam }
}

const signal = new AbortController().signal

/** Tool names visible on the child's captured request, in request order. */
function visibleTools(request: { tools?: Array<{ name?: string }> }): string[] {
  return (request.tools ?? []).map(tool => tool.name ?? '')
}

describe('memory-recall child tool surface (integration tripwire)', () => {
  it('a fork with the recall request shape sees only {read, structured_output}, both present', async () => {
    const { adapter, parent, subagents } = await setup()
    const run = await subagents.start('fork', {
      label: 'memory-recall',
      prompt: [{ type: 'text', text: 'select memories' }],
      parent,
      signal,
      toolFilter: RECALL_TOOL_FILTER,
      outputSchema: RECALL_FILES_SCHEMA,
      maxDepth: 1,
    })
    const settled = await run.result
    expect(settled.stopReason).toBe('completed')

    expect(adapter.requests).toHaveLength(1)
    const tools = visibleTools(adapter.requests[0]!)
    // Diagnostic first: an unexpected widening names the offending tool here.
    expect(tools).toEqual(expect.arrayContaining(['read', 'structured_output']))
    for (const name of tools) {
      expect(name, `tool "${name}" leaked past RECALL_TOOL_FILTER`).toBeOneOf(['read', 'structured_output'])
    }
  })

  it('NEGATIVE CONTROL: the same fork without a toolFilter sees a strictly larger surface', async () => {
    const { adapter, parent, subagents } = await setup()
    const run = await subagents.start('fork', {
      label: 'memory-recall-unfiltered',
      prompt: [{ type: 'text', text: 'select memories' }],
      parent,
      signal,
      outputSchema: RECALL_FILES_SCHEMA,
      maxDepth: 1,
    })
    await run.result
    expect(adapter.requests).toHaveLength(1)
    const tools = visibleTools(adapter.requests[0]!)
    expect(tools.length).toBeGreaterThan(2)
    // And the control is genuinely unfiltered: something outside the invariant set is visible.
    expect(tools.some(name => name !== 'read' && name !== 'structured_output')).toBe(true)
  })
})
