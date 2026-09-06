/**
 * Tests for the Task tool's spawn-time pre-activation of allow-listed deferred
 * MCP tools: explicit `tools:` entries that are still deferred get activated at
 * spawn (both dispatch paths), wildcard entries are restrict-only, deny and
 * sanitize survivors gate the candidates, and outcomes surface in the result
 * text.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@dsh-cc/tools'
import DeferredToolRegistry from '@dsh-cc/tool-search'
import { AgentRegistry } from '../src/registry.ts'
import { registerTaskTool, TASK_TOOL } from '../src/tool.ts'

const DEFERRED_MCP = 'mcp__github__create_issue'

interface FakeProvider {
  name: string
  capabilities: { outputSchema: boolean; depthLimit: boolean; toolFilter: boolean; persona: boolean }
  prepareContinuable?: () => Promise<unknown>
  start(request: Record<string, unknown>): Promise<{ result: Promise<{ stopReason: string; output?: readonly { type: string; text?: string }[] }> }>
}

function capableProvider(name: string): FakeProvider {
  return {
    name,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    prepareContinuable: async () => ({}),
    start: async () => ({ result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] }) }),
  }
}

const tmpRoots: string[] = []

function freshWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'preload-tools-'))
  tmpRoots.push(dir)
  return dir
}

function writeAgent(root: string, name: string, body: string): void {
  const agents = join(root, '.claude', 'agents')
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, `${name}.md`), body, 'utf8')
}

function agentAt(cwd: string): Agent {
  return { session: { header: { cwd } } } as unknown as Agent
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A duck-typed toolSearch seam stub: records every activate call (name +
 * scope + position in the shared `order` log) and answers from `outcomes`
 * (default `loaded`).
 */
function fakeToolSearch(
  order: string[],
  outcomes: Record<string, { status: string; reason?: string }> = {},
): { seam: Record<string, unknown>; activations: Array<{ name: string; agent: unknown }> } {
  const activations: Array<{ name: string; agent: unknown }> = []
  const seam = {
    activate(name: string, agent?: unknown) {
      activations.push({ name, agent })
      order.push('activate')
      const outcome = outcomes[name] ?? { status: 'loaded' }
      return { name, ...outcome }
    },
  }
  return { seam, activations }
}

async function mount(opts: { toolSearch?: unknown; order?: string[] } = {}): Promise<{
  ctx: Context
  continuableStarts: Array<{ provider: string; request: Record<string, unknown> }>
  order: string[]
  activations: Array<{ name: string; agent: unknown }>
  warn: ReturnType<typeof vi.fn>
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const emit = (event: string, info: Record<string, unknown>): void => {
    ;(ctx as unknown as { emit(event: string, info: unknown): void }).emit(event, info)
  }
  const provider = capableProvider('spawn')
  const continuableStarts: Array<{ provider: string; request: Record<string, unknown> }> = []
  const order = opts.order ?? []
  const seam: Record<string, unknown> = {
    async startContinuable(spec: Record<string, unknown>): Promise<{ childId: string; messageId: string }> {
      order.push('start')
      continuableStarts.push({ provider: spec['provider'] as string, request: spec['request'] as Record<string, unknown> })
      const childId = (spec['childId'] as string | undefined) ?? `child-${continuableStarts.length}`
      const runId = `run-${continuableStarts.length}`
      // Mirror the harness: subagent/start fires for the first epoch before
      // the creation call resolves (the collector reserves before start).
      emit('subagent/start', { runId, provider: 'spawn', id: childId, local: true })
      const settled = await (await provider.start(spec['request'] ?? {})).result
      emit('subagent/end', {
        runId,
        provider: 'spawn',
        id: childId,
        local: true,
        stopReason: settled.stopReason,
        ...(settled.output !== undefined ? { lastAssistantMessage: settled.output } : {}),
      })
      return { childId, messageId: 'm-1' }
    },
    getProvider(name: string) { return name === 'spawn' ? provider : undefined },
    list() { return ['spawn'] },
  }
  ctx.provide('subagents', seam)
  if (opts.toolSearch !== undefined) ctx.provide('toolSearch', opts.toolSearch)
  const warn = vi.fn()
  ;(ctx as unknown as { logger?: Record<string, unknown> }).logger
    = { ...(ctx as unknown as { logger?: Record<string, unknown> }).logger, warn }
  registerTaskTool(ctx, new AgentRegistry())
  return { ctx, continuableStarts, order, activations: [], warn }
}

let callCounter = 0
async function call(ctx: Context, args: Record<string, unknown>, agent?: Agent) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `call-${++callCounter}` as never,
    name: TASK_TOOL,
    arguments: args,
    ...(agent !== undefined ? { agent } : {}),
  })
  return result as { isError: boolean; content: { type: string; text: string }[] }
}

function reserveNames(ctx: Context, ...names: string[]): void {
  for (const name of names) ctx.tools.reserve(name)
}

describe('spawn-time preload of deferred toolFilter names', () => {
  it('activates an explicit deferred allow name with the calling agent BEFORE the spawn, and says so', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'mcp-user', '---\nname: mcp-user\ndescription: MCP\ntools: [Read, mcp__github__create_issue]\n---\nMCP.\n')
    const order: string[] = []
    const { seam, activations } = fakeToolSearch(order)
    const { ctx, continuableStarts } = await mount({ toolSearch: seam, order })
    reserveNames(ctx, 'read', 'read_image', DEFERRED_MCP)
    const caller = agentAt(ws)
    const result = await call(ctx, { subagent_type: 'mcp-user', description: 'x', prompt: 't' }, caller)
    expect(activations).toEqual([{ name: DEFERRED_MCP, agent: caller }])
    // Pre-activation must happen before the child start on BOTH paths.
    expect(order).toEqual(['activate', 'start'])
    expect(continuableStarts).toHaveLength(1)
    const filter = continuableStarts[0]!.request['toolFilter'] as { allow?: string[] }
    expect(filter.allow).toContain(DEFERRED_MCP)
    expect(result.content[0]!.text).toContain(`Preloaded deferred tools for child: ${DEFERRED_MCP}`)
  })

  it('skips a name that is already registered (eager)', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'eager', '---\nname: eager\ndescription: E\ntools: [mcp__github__search]\n---\nE.\n')
    const order: string[] = []
    const { seam, activations } = fakeToolSearch(order)
    const { ctx } = await mount({ toolSearch: seam })
    reserveNames(ctx, 'mcp__github__search')
    ctx.tools.register(defineTool({
      name: 'mcp__github__search',
      description: 'Already mounted.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute: () => Promise.resolve('ok'),
    }))
    await call(ctx, { subagent_type: 'eager', description: 'x', prompt: 't' }, agentAt(ws))
    expect(activations).toEqual([])
  })

  it('never activates a name the sanitized deny list excludes', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'denied', '---\nname: denied\ndescription: D\ntools: [mcp__github__create_issue]\ndisallowedTools: [mcp__github__create_issue]\n---\nD.\n')
    const order: string[] = []
    const { seam, activations } = fakeToolSearch(order)
    const { ctx } = await mount({ toolSearch: seam })
    reserveNames(ctx, DEFERRED_MCP)
    await call(ctx, { subagent_type: 'denied', description: 'x', prompt: 't' }, agentAt(ws))
    expect(activations).toEqual([])
  })

  it('never activates a name sanitize drops as unknown', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'typo', '---\nname: typo\ndescription: T\ntools: [mcp__nope__missing]\n---\nT.\n')
    const order: string[] = []
    const { seam, activations } = fakeToolSearch(order)
    const { ctx } = await mount({ toolSearch: seam })
    await call(ctx, { subagent_type: 'typo', description: 'x', prompt: 't' }, agentAt(ws))
    expect(activations).toEqual([])
  })

  it('treats a server-level wildcard entry as restrict-only (no activation)', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'wild', '---\nname: wild\ndescription: W\ntools: [mcp__fakesrv]\n---\nW.\n')
    const order: string[] = []
    const { seam, activations } = fakeToolSearch(order)
    const { ctx } = await mount({ toolSearch: seam })
    reserveNames(ctx, 'mcp__fakesrv__alpha', 'mcp__fakesrv__beta')
    await call(ctx, { subagent_type: 'wild', description: 'x', prompt: 't' }, agentAt(ws))
    expect(activations).toEqual([])
  })

  it('degrades to warn-only and a normal spawn when no toolSearch seam is mounted', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'mcp-user', '---\nname: mcp-user\ndescription: MCP\ntools: [mcp__github__create_issue]\n---\nMCP.\n')
    const { ctx, continuableStarts, warn } = await mount()
    reserveNames(ctx, DEFERRED_MCP)
    const result = await call(ctx, { subagent_type: 'mcp-user', description: 'x', prompt: 't' }, agentAt(ws))
    expect(continuableStarts).toHaveLength(1)
    expect(result.content[0]!.text).not.toContain('Preloaded')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('toolSearch'))
  })

  it('preloads on the background path and carries the line in the launch result text', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'bg-mcp', '---\nname: bg-mcp\ndescription: B\ntools: [mcp__github__create_issue]\n---\nB.\n')
    const order: string[] = []
    const { seam, activations } = fakeToolSearch(order)
    const { ctx, continuableStarts } = await mount({ toolSearch: seam, order })
    reserveNames(ctx, DEFERRED_MCP)
    const result = await call(ctx, {
      subagent_type: 'bg-mcp',
      description: 'x',
      prompt: 't',
      run_in_background: true,
    }, agentAt(ws))
    expect(activations).toHaveLength(1)
    expect(order).toEqual(['activate', 'start'])
    expect(continuableStarts).toHaveLength(1)
    expect(result.content[0]!.text).toContain('Background subagent started')
    expect(result.content[0]!.text).toContain(`Preloaded deferred tools for child: ${DEFERRED_MCP}`)
  })

  it('surfaces a denied activation as a notice in the foreground result and still spawns', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'restricted', '---\nname: restricted\ndescription: R\ntools: [mcp__github__create_issue]\n---\nR.\n')
    const order: string[] = []
    const { seam } = fakeToolSearch(order, {
      [DEFERRED_MCP]: { status: 'denied', reason: '"mcp__github__create_issue" is restricted for this agent' },
    })
    const { ctx, continuableStarts } = await mount({ toolSearch: seam })
    reserveNames(ctx, DEFERRED_MCP)
    const result = await call(ctx, { subagent_type: 'restricted', description: 'x', prompt: 't' }, agentAt(ws))
    expect(continuableStarts).toHaveLength(1)
    expect(result.content[0]!.text).toContain(`Not preloaded: ${DEFERRED_MCP} (restricted for this agent`)
  })

  it('reports already-loaded as silent success (no notice)', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'loaded', '---\nname: loaded\ndescription: L\ntools: [mcp__github__create_issue]\n---\nL.\n')
    const order: string[] = []
    const { seam } = fakeToolSearch(order, { [DEFERRED_MCP]: { status: 'already-loaded' } })
    const { ctx } = await mount({ toolSearch: seam })
    reserveNames(ctx, DEFERRED_MCP)
    const result = await call(ctx, { subagent_type: 'loaded', description: 'x', prompt: 't' }, agentAt(ws))
    expect(result.content[0]!.text).toContain(`Preloaded deferred tools for child: ${DEFERRED_MCP}`)
    expect(result.content[0]!.text).not.toContain('Not preloaded')
  })
})

describe('integration: real DeferredToolRegistry preload', () => {
  it('activates a real deferred MCP tool at spawn so it becomes registered and model-visible', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'mcp-user', '---\nname: mcp-user\ndescription: MCP\ntools: [mcp__fakesrv__heavy_tool]\n---\nMCP.\n')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(DeferredToolRegistry)
    ctx.toolSearch.registerDeferred({
      name: 'mcp__fakesrv__heavy_tool',
      description: 'Heavy MCP capability.',
      searchHint: 'heavy mcp',
      activate: () => ctx.tools.register(defineTool({
        name: 'mcp__fakesrv__heavy_tool',
        description: 'Heavy MCP capability.',
        parameters: { value: { type: 'string' } },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: args => Promise.resolve(args['value'] ?? 'ok'),
      })),
    })
    const search = vi.spyOn(ctx.toolSearch, 'search')
    const provider = capableProvider('spawn')
    const seam: Record<string, unknown> = {
      async startContinuable(spec: Record<string, unknown>): Promise<{ childId: string; messageId: string }> {
        const childId = String(spec['childId'])
        ;(ctx as unknown as { emit(event: string, info: unknown): void }).emit('subagent/start', {
          runId: 'run-1',
          provider: 'spawn',
          id: childId,
          local: true,
        })
        await provider.start({})
        ;(ctx as unknown as { emit(event: string, info: unknown): void }).emit('subagent/end', {
          runId: 'run-1',
          provider: 'spawn',
          id: childId,
          local: true,
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: 'done' }],
        })
        return { childId, messageId: 'm-1' }
      },
      getProvider(name: string) { return name === 'spawn' ? provider : undefined },
      list() { return ['spawn'] },
    }
    ctx.provide('subagents', seam)
    registerTaskTool(ctx, new AgentRegistry())

    const result = await call(ctx, { subagent_type: 'mcp-user', description: 'x', prompt: 't' }, agentAt(ws))
    expect(result.isError).toBe(false)
    expect(result.content[0]!.text).toContain('Preloaded deferred tools for child: mcp__fakesrv__heavy_tool')
    // Registered on the real tools runtime → enters the child's first assembly.
    expect(ctx.tools.get('mcp__fakesrv__heavy_tool')).toBeDefined()
    const assembly = await ctx.systemPrompt.assemble({ agent: agentAt(ws) })
    expect(assembly.tools.map(tool => tool.name)).toContain('mcp__fakesrv__heavy_tool')
    // Activation happened without any ToolSearch search call.
    expect(search).not.toHaveBeenCalled()
  })
})
