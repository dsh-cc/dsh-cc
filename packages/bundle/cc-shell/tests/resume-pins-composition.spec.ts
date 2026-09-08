/**
 * Production wiring for resume pins (plan docs/plans/2026-09-04-subagent-resume-pins.md
 * §4.10): the real Task plugin composed with the resume-pins plugin the way the
 * CC preset mounts them (`packages/preset/cc/agent.cordis.yml`, `cc-services`
 * group: `cc-resume-pins` BEFORE `tool-task`). The Task plugin is mounted with
 * NO `resumePins` config on purpose — capture must arm from the plugin-provided
 * `resumePinStore` service, and the pin must land under the composed pinsRoot.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ControlTools from '@deepseek-ai/dsh-tool-subagent-control'
import * as ListAgents from '@deepseek-ai/dsh-tool-subagent-control/list-agents'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'
import { defineTool } from '@dsh-cc/tools'
import { PinStore, applyResumePinsPlugin } from '@dsh-cc/subagent-resume-pins'
import { apply as applyTask } from '@dsh-cc/subagent-task'
import { apply as applyModelRoutes, type ModelRoutes } from '@dsh-cc/model-aliases'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Compose the preset's delegation + resume-pins surface over one root. */
async function compose(script: ConstructorParameters<typeof MockAdapter>[0] = []) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  const root = mkdtempSync(join(tmpdir(), 'cc-shell-resume-pins-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(ControlTools)
  await ctx.plugin(ListAgents)
  // A deployment tool surface + the name-reservation shim, as integration.spec.ts.
  ctx.tools.register(defineTool({
    name: 'read',
    description: 'read',
    parameters: {},
    output: { schema: { type: 'null' }, render: () => [] },
    async execute() { return null },
  }))
  const tools = ctx.get('tools') as { reserve?(name: string): () => void }
  if (typeof tools.reserve !== 'function') {
    const reserved = new Set<string>()
    tools.reserve = (name: string) => {
      reserved.add(name)
      return () => { reserved.delete(name) }
    }
  }
  // Production row order: the real model-routes service (agent.cordis.yml
  // `cc-model-routes` row, before the cc-services group), then the pins plugin
  // (which publishes `resumePinStore`) BEFORE the Task plugin, which then arms
  // capture with no config. The REAL service must be mounted: the Task tool's
  // resume-pin capture calls `resolveDetailed` on it — without this row the
  // TypeError gap in the published service object is invisible to the test.
  await ctx.plugin(applyModelRoutes, {})
  expect(ctx.get('ccModelRoutes') as ModelRoutes | undefined).toBeDefined()
  const pinsRoot = join(root, 'resume-pins')
  applyResumePinsPlugin(ctx, { pinsRoot })
  applyTask(ctx)
  // A named `.claude/agents` definition: the named-definition background path
  // is the one that calls `routes.resolveDetailed` on the real service (the
  // subagent_type-less plain-spawn path inherits the selector instead).
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, '.claude', 'agents'), { recursive: true })
  writeFileSync(
    join(workspace, '.claude', 'agents', 'researcher.md'),
    '---\nname: researcher\ndescription: reads things\n---\nRESEARCHER PERSONA MARKER\n',
    'utf8',
  )
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
  return { ctx, parent, pinsRoot }
}

describe('cc-shell resume-pins composition (§4.10)', () => {
  it('mounts the pins plugin and the Task plugin with the shared store service', async () => {
    const { ctx } = await compose()
    const store = ctx.get('resumePinStore') as PinStore | undefined
    expect(store, 'the pins plugin must publish the `resumePinStore` service').toBeInstanceOf(PinStore)
    // Both control tools and the CC Task tool are registered exactly once.
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names.filter(name => name === 'subagent_fork')).toHaveLength(1)
    expect(names.filter(name => name === 'send_message')).toHaveLength(1)
    expect(names.filter(name => name === 'list_agents')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('arms capture from the service store: a background Task spawn writes a pin under the composed pinsRoot', async () => {
    const { ctx, parent, pinsRoot } = await compose([textResponse('working')])
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('call-1'),
      name: 'subagent_fork',
      arguments: { description: 'long research', prompt: 'slow work', subagent_type: 'researcher', run_in_background: true },
      agent: parent as never,
    })
    expect(result.isError).toBe(false)
    const notice = (result.content ?? [])
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('')
    const agentId = /agentId: ([0-9a-f-]{36})/.exec(notice)?.[1]
    expect(agentId, `background notice must name the durable id, got: ${notice}`).toBeTypeOf('string')

    // The pin is readable through a FRESH store over the composed root: it
    // landed on disk under the pinsRoot, colocated with the persistence root.
    const pin = new PinStore(pinsRoot).read(agentId!)
    expect(pin, 'the background spawn must write a pin under the composed pinsRoot').toBeDefined()
    expect(pin).toMatchObject({
      version: 1,
      childId: agentId,
      parentSessionId: 'parent',
      mode: 'continuable-background',
      resume: { state: 'ok' },
    })
    // Wait for the child's turn to close so the composition settles cleanly.
    await vi.waitFor(() => expect(ctx.agents.get(SessionId(agentId!))).toBeUndefined(), { timeout: 10_000 })
  }, 20_000)
})
