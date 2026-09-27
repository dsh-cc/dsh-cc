/**
 * Real-entry coverage for the System One chat guard: the Task tool, driven
 * through `ctx.tools.execute` with the REAL `cc-model-routes` service mounted,
 * must refuse an agent definition whose frontmatter `model:` names the System
 * One `gauge` lane — a hard, actionable tool error, and no child is ever
 * spawned — while an ordinary chat alias still dispatches.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import { apply as applyModelRoutes } from '@dsh-cc/model-aliases'
import { AgentRegistry } from '../src/registry.ts'
import { registerTaskTool, TASK_TOOL } from '../src/tool.ts'

const BLESSED = {
  gauge: { provider: 'orchestrix', model: 'llmbox_systemone/laya', protocol: 'systemone' },
  haiku: { provider: 'orchestrix', model: 'llmbox_ant/haiku' },
}

const COMPLETED = { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] } as const

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspaceWith(agents: Record<string, string>): string {
  const ws = mkdtempSync(join(tmpdir(), 'task-systemone-'))
  roots.push(ws)
  mkdirSync(join(ws, '.claude', 'agents'), { recursive: true })
  for (const [name, model] of Object.entries(agents)) {
    writeFileSync(join(ws, '.claude', 'agents', `${name}.md`), `---\nname: ${name}\ndescription: ${name} agent\nmodel: ${model}\n---\n${name} persona.\n`)
  }
  return ws
}

/** Real Task tool + real routes service; a recording in-process seam stands in for the harness. */
async function mount() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const starts: Record<string, unknown>[] = []
  const provider = {
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    prepareContinuable: async () => ({}),
    start: async () => ({ result: Promise.resolve(COMPLETED) }),
  }
  const emit = (event: string, info: Record<string, unknown>): void => {
    ;(ctx as unknown as { emit(event: string, info: unknown): void }).emit(event, info)
  }
  ctx.provide('subagents', {
    async start(name: string, request: Record<string, unknown>) {
      starts.push({ provider: name, ...request })
      return provider.start()
    },
    async startContinuable(spec: Record<string, unknown>) {
      const childId = (spec['childId'] as string | undefined) ?? `child-${starts.length + 1}`
      const runId = `run-${starts.length + 1}`
      const providerName = spec['provider'] as string
      emit('subagent/start', { runId, provider: providerName, id: childId, local: true })
      starts.push(spec)
      void (async () => {
        const settled = await (await provider.start()).result
        emit('subagent/end', { runId, provider: providerName, id: childId, local: true, stopReason: settled.stopReason, lastAssistantMessage: settled.output })
      })()
      return { childId, messageId: 'm-1' }
    },
    getProvider: (name: string) => (name === 'spawn' || name === 'fork' ? { name, ...provider } : undefined),
    list: () => ['spawn', 'fork'],
  })
  applyModelRoutes(ctx, { modelAliases: BLESSED as never })
  registerTaskTool(ctx, new AgentRegistry(), undefined)
  return { ctx, starts }
}

async function callTask(ctx: Context, ws: string, subagentType: string) {
  return await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `call-${subagentType}` as never,
    name: TASK_TOOL,
    arguments: { subagent_type: subagentType, description: 'judge it', prompt: 'is this safe?' },
    agent: { session: { header: { cwd: ws } } } as unknown as Agent,
  }) as { isError: boolean; content: { type: string; text: string }[] }
}

describe('Task tool refuses the System One gauge lane as a chat model', () => {
  it('a definition with `model: gauge` fails with SystemOneChatModelError copy and spawns nothing', async () => {
    const ws = workspaceWith({ judge: 'gauge' })
    const { ctx, starts } = await mount()
    const result = await callTask(ctx, ws, 'judge')
    expect(result.isError).toBe(true)
    const text = result.content.map(block => block.text).join('\n')
    expect(text).toContain('System One model "orchestrix/llmbox_systemone/laya" cannot be used as a chat model')
    expect(text).toContain('permission-rules')
    expect(starts).toHaveLength(0)
  })

  it('an ordinary chat alias (`model: haiku`) still dispatches with its route', async () => {
    const ws = workspaceWith({ scout: 'haiku' })
    const { ctx, starts } = await mount()
    const result = await callTask(ctx, ws, 'scout')
    expect(result.isError).toBe(false)
    expect(starts).toHaveLength(1)
    const request = (starts[0]!['request'] ?? starts[0]) as Record<string, unknown>
    expect(request['agentOptions']).toEqual({ provider: 'orchestrix', model: 'llmbox_ant/haiku' })
  })
})
