/**
 * Real-stack tripwire for the dream fork (§5.4), modeled on
 * recall-tool-surface.spec.ts: through the REAL in-process fork driver with
 * the production dream request shape (MEMORY_TOOL_FILTER + MEMORY_WRITES_SCHEMA)
 * and no global StructuredOutput tool registered, the child materializes, the
 * injected child-scoped `structured_output` tool is visible on the captured
 * model request, the child's call is captured into `res.structured`, and
 * `writeMemoryFiles` persists the report into a tmp memory dir.
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
import { MEMORY_TOOL_FILTER, MEMORY_WRITES_SCHEMA, validateMemoryWrites, writeMemoryFiles } from '@dsh-cc/memory'

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
  }): Promise<{ result: Promise<{ stopReason: string; structured?: unknown }> }>
}

const TOPIC_WRITE = { path: 'dream-topic.md', content: '# Dream topic\n\nBody.\n' }

/** Same stack as recall-tool-surface: real restrict semantics, mock LLM. */
async function setup(): Promise<{
  adapter: MockAdapter
  parent: Agent
  subagents: SubagentsSeam
}> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-dream-surface-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  // Global surface: read/grep/glob/read_image — deliberately NO global
  // StructuredOutput (the production deployment whose dream threw).
  for (const name of ['read', 'read_image', 'grep', 'glob'] as const) {
    ctx.tools.register(defineTool({
      name,
      description: name,
      parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      async execute() { return null },
    }))
  }
  const adapter = new MockAdapter([toolCallResponse('c1', 'structured_output', { writes: [TOPIC_WRITE] })])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { adapter, parent, subagents: ctx.get('subagents') as SubagentsSeam }
}

const signal = new AbortController().signal

describe('memory dream fork tool surface (integration tripwire)', () => {
  it('dispatches with MEMORY_TOOL_FILTER, sees the injected structured_output, and reports writes', async () => {
    const { adapter, parent, subagents } = await setup()
    const run = await subagents.start('fork', {
      label: 'memory-consolidation',
      prompt: [{ type: 'text', text: 'consolidate memories' }],
      parent,
      signal,
      toolFilter: MEMORY_TOOL_FILTER,
      outputSchema: MEMORY_WRITES_SCHEMA,
      maxDepth: 1,
    })
    const settled = await run.result
    expect(settled.stopReason).toBe('completed')
    // The child's structured_output call was captured into res.structured.
    expect(settled.structured).toEqual({ writes: [TOPIC_WRITE] })

    expect(adapter.requests).toHaveLength(1)
    const tools = (adapter.requests[0]!.tools ?? []).map(tool => tool.name ?? '')
    // The driver-injected reporting tool is visible even though the filter
    // does not (and must not) allow-list it.
    expect(tools).toContain('structured_output')
    expect(tools).toContain('read')
  })

  it('writeMemoryFiles lands the reported topic file in a tmp memory dir', async () => {
    const memDir = mkdtempSync(join(tmpdir(), 'dsh-dream-mem-'))
    roots.push(memDir)
    // Minimal FileSystem-compatible seam (same shape memory-job's fs mock).
    const backing = new Map<string, string>()
    const fs = {
      async resolve(path: string) { return { targetKey: path, displayPath: path } },
      async writeText(target: unknown, content: string) {
        backing.set(String((target as { targetKey: unknown }).targetKey), content)
        return { operation: 'create', version: 'v1', before: null, after: content }
      },
    } as unknown as Parameters<typeof writeMemoryFiles>[0]
    const written = await writeMemoryFiles(fs, memDir, validateMemoryWrites({ writes: [TOPIC_WRITE] }))
    expect(written).toEqual(['dream-topic.md'])
    expect(backing.get(join(memDir, 'dream-topic.md'))).toBe(TOPIC_WRITE.content)
  })
})
