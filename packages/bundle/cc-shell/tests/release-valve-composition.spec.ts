/**
 * Release-valve composition (plan docs/plans/2026-09-30-subagent-release-valve.md
 * §6 T25): ONE Context carries the task plugin AND the command-agents plugin
 * the way the cc preset mounts them. `release_agent` runs through the tools
 * seam, `/agents` through the commands seam, and BOTH observe the same
 * module-instance marker set — the snapshot's `[released]` tag renders from
 * the marker the tool operation recorded (codex r3 #13).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ControlTools from '@deepseek-ai/dsh-tool-subagent-control'
import * as ListAgents from '@deepseek-ai/dsh-tool-subagent-control/list-agents'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'
import { defineTool } from '@dsh-cc/tools'
import { applyResumePinsPlugin } from '@dsh-cc/subagent-resume-pins'
import { apply as applyTask } from '@dsh-cc/subagent-task'
import { apply as applyCommandAgents } from '@dsh-cc/command-agents'
import { isReleased, isReleasing } from '@dsh-cc/command-agents/release'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Compose task + command-agents over one root (preset row order). */
async function compose(script: ConstructorParameters<typeof MockAdapter>[0] = []) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'cc-shell-release-valve-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(SessionQuery)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(ControlTools)
  await ctx.plugin(ListAgents)
  ctx.tools.register(defineTool({
    name: 'read',
    description: 'read',
    parameters: {},
    output: { schema: { type: 'null' }, render: () => [] },
    async execute() { return null },
  }))
  const tools = ctx.get('tools') as { reserve?(name: string): () => void }
  if (typeof tools.reserve !== 'function') {
    tools.reserve = () => () => {}
  }
  applyResumePinsPlugin(ctx, { pinsRoot: join(root, 'resume-pins') })
  applyTask(ctx)
  applyCommandAgents(ctx)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(
    SessionId('parent'),
    { provider: 'mock', model: 'mock' },
    { cwd: join(root, 'workspace') },
  )
  ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
    if (subject !== parent) return next()
    return { kind: 'reject' as const }
  })
  return { ctx, parent }
}

describe('cc-shell release-valve composition (T25)', () => {
  it('release_agent marks released and /agents renders the [released] tag from the same marker module', async () => {
    const { ctx, parent } = await compose(['hang', textResponse('after release')])

    // A hung running child.
    const start = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('call-1'),
      name: 'subagent_fork',
      arguments: { description: 'long research', prompt: 'slow work', run_in_background: true },
      agent: parent as never,
    })
    expect(start.isError).toBe(false)
    const agentId = /agentId: ([0-9a-f-]{36})/.exec(
      (start.content ?? []).flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
    )?.[1]
    expect(agentId).toBeTypeOf('string')
    const childId = SessionId(agentId!)
    await vi.waitFor(() => {
      const child = ctx.agents.get(childId)
      expect(child).toBeDefined()
      expect(child!.status).toBe('running')
    }, { timeout: 10_000 })

    // release_agent through the tools seam.
    const release = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('call-2'),
      name: 'release_agent',
      arguments: { agent_id: agentId! },
      agent: parent as never,
    })
    expect(release.isError).toBe(false)
    const releaseText = (release.content ?? [])
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    expect(releaseText).toContain(`Released agent ${agentId}`)

    // Module-instance marker identity: the tool operation marked it.
    expect(isReleased(agentId!)).toBe(true)
    expect(isReleasing(agentId!)).toBe(false)

    // The eviction settles.
    await vi.waitFor(() => expect(ctx.agents.get(childId)).toBeUndefined(), { timeout: 10_000 })

    // `/agents` through the commands seam renders the row with [released]
    // (rows display the 8-char short id).
    const shortId = agentId!.split('-').at(-1)!.slice(0, 8)
    const agentsText = await (ctx.commands.execute(parent, '/agents', [], new AbortController().signal) as Promise<{ result?: { text?: string } }>)
      .then(r => r.result?.text ?? '')
    expect(agentsText).toContain(shortId)
    expect(agentsText).toContain('[released]')

    // buildAgentsSnapshot (via the published ccAgents service) agrees.
    const snapshot = ctx.get('ccAgents') as
      { list(parent: string): Promise<{ id: string; released?: boolean }[]> } | undefined
    expect(snapshot).toBeDefined()
    const rows = await snapshot!.list('parent')
    expect(rows.find(row => row.id === agentId)?.released).toBe(true)
  }, 30_000)
})
