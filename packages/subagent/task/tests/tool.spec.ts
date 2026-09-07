/**
 * Tests for the CC-compatible Task tool: subagent_type dispatch over the
 * per-workspace AgentRegistry, persona-based definition delivery, model-alias
 * route resolution, and the toolFilter sanitization that keeps disabled
 * harness rows out of scoped restricts.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import type { ToolRestriction } from '@dsh-cc/claude-code-agents'
import { AgentRegistry } from '../src/registry.ts'
import type { AgentDefinition } from '@dsh-cc/claude-code-agents'
import { backgroundTasksDisabled, registerTaskTool, TASK_TOOL } from '../src/tool.ts'
import { PinStore } from '@dsh-cc/subagent-resume-pins'
import { SpawnPinCapture } from '../src/resume-capture.ts'
import { BACKGROUND_SECTION_TEXT } from '../src/index.ts'
import { collectorsForSession } from '../src/epoch-collector.ts'
import { PLUGIN_AGENT_PROVIDER_BRAND } from '@dsh-cc/plugin-loader'

/** A faithfully-capability-checking fake subagents seam (mirrors assertCapabilities). */
interface FakeProvider {
  name: string
  capabilities: { outputSchema: boolean; depthLimit: boolean; toolFilter: boolean; persona: boolean }
  /** Present only on providers implementing the continuable-creation capability. */
  prepareContinuable?: () => Promise<unknown>
  start(request: Record<string, unknown>): Promise<{ result: Promise<{ stopReason: string; output?: readonly { type: string; text?: string }[] }> }>
  /** Present only on plugin agent providers (the AgentProvider shape). */
  definition?: AgentDefinition
}

/** A plugin agent provider: the AgentProvider shape the seam carries (never started by Task).
 * Stamped with the loader brand so PluginAgentIndex adopts it (plan §9.4). */
function pluginProvider(
  id: string,
  def: { agentType?: string; systemPrompt: string; toolRestriction?: ToolRestriction; background?: boolean; model?: string },
): FakeProvider {
  return {
    name: id,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    prepareContinuable: async () => ({}),
    start: async () => ({ result: Promise.resolve(COMPLETED) }),
    [PLUGIN_AGENT_PROVIDER_BRAND]: true,
    definition: {
      agentType: def.agentType ?? id.split(':').pop()!,
      whenToUse: `${id} when needed`,
      systemPrompt: def.systemPrompt,
      source: 'project',
      baseDir: '/plugins/p/agents',
      filename: def.agentType ?? id,
      ...(def.toolRestriction !== undefined ? { toolRestriction: def.toolRestriction } : {}),
      ...(def.background !== undefined ? { background: def.background } : {}),
      ...(def.model !== undefined ? { model: def.model } : {}),
    } as AgentDefinition,
  }
}

/** One recorded `startContinuable` call (the background dispatch path). */
interface RecordedContinuable {
  provider: string
  label: string
  request: Record<string, unknown>
}

interface StartedRun {
  provider: string
  request: Record<string, unknown>
}

interface FakeRun {
  result: Promise<{ stopReason: string; output?: readonly { type: string; text?: string }[] }>
}

interface EpochShape {
  stopReason: string
  output?: readonly { type: string; text?: string }[]
}

function makeSeam(
  providers: FakeProvider[],
  emit?: (event: string, info: Record<string, unknown>) => void,
): {
  seam: unknown
  runs: StartedRun[]
  continuableStarts: RecordedContinuable[]
  /** The durable child ids handed out by startContinuable, in order. */
  startedChildIds: string[]
  emitEnd: (childId: string, epoch: EpochShape) => void
} {
  const runs: StartedRun[] = []
  const continuableStarts: RecordedContinuable[] = []
  const startedChildIds: string[] = []
  const runIdByChild = new Map<string, string>()
  const byName = new Map(providers.map(p => [p.name, p]))
  const seam: Record<string, unknown> = {
    async start(name: string, request: Record<string, unknown>): Promise<FakeRun> {
      const provider = byName.get(name)
      if (provider === undefined) throw new Error(`unknown provider "${name}"`)
      const caps = provider.capabilities
      if (request['persona'] !== undefined && !caps.persona) throw new Error('UNSUPPORTED_CAPABILITY persona')
      if (request['toolFilter'] !== undefined && !caps.toolFilter) throw new Error('UNSUPPORTED_CAPABILITY toolFilter')
      if (request['maxDepth'] !== undefined && !caps.depthLimit) throw new Error('UNSUPPORTED_CAPABILITY maxDepth')
      if (request['outputSchema'] !== undefined && !caps.outputSchema) throw new Error('UNSUPPORTED_CAPABILITY outputSchema')
      runs.push({ provider: name, request })
      return provider.start(request)
    },
    async startContinuable(spec: Record<string, unknown>): Promise<{ childId: string; messageId: string }> {
      const providerName = spec['provider'] as string
      const provider = byName.get(providerName)
      if (provider === undefined) throw new Error(`unknown provider "${providerName}"`)
      if (provider.prepareContinuable === undefined) {
        const error = new Error(
          `subagent provider "${providerName}" does not support continuable children (no prepareContinuable capability)`,
        ) as Error & { code?: string }
        error.code = 'UNSUPPORTED_CAPABILITY'
        throw error
      }
      const childId = (spec['childId'] as string | undefined) ?? `child-${continuableStarts.length + 1}`
      const runId = `run-${continuableStarts.length + 1}`
      // Mirror the harness: `subagent/start` fires for the first epoch; the
      // epoch settles synchronously here so the collector (which reserved
      // before start) catches the end event like an immediate settle.
      emit?.('subagent/start', { runId, provider: providerName, id: childId, local: true })
      continuableStarts.push({
        provider: providerName,
        label: spec['label'] as string,
        request: spec['request'] as Record<string, unknown>,
      })
      startedChildIds.push(childId)
      runIdByChild.set(childId, runId)
      // The epoch's terminal is emitted asynchronously — startContinuable
      // itself returns once the child accepted its prompt (never awaiting
      // the epoch), and a pending provider keeps its epoch unsettled.
      void (async () => {
        const settled = await (await provider.start(spec['request'] ?? {})).result
        emit?.('subagent/end', {
          runId,
          provider: providerName,
          id: childId,
          local: true,
          stopReason: settled.stopReason,
          ...(settled.output !== undefined ? { lastAssistantMessage: settled.output } : {}),
        })
      })()
      return { childId, messageId: 'm-1' }
    },
    getProvider(name: string) { return byName.get(name) },
    list() { return [...byName.keys()] },
  }
  return {
    seam,
    runs,
    continuableStarts,
    startedChildIds,
    emitEnd(childId, epoch) {
      emit?.('subagent/end', {
        runId: runIdByChild.get(childId) ?? `run-?${childId}`,
        provider: 'spawn',
        id: childId,
        local: true,
        stopReason: epoch.stopReason,
        ...(epoch.output !== undefined ? { lastAssistantMessage: epoch.output } : {}),
      })
    },
  }
}

/** A capable in-process provider with a captured result. */
function capableProvider(
  name: string,
  result: { stopReason: string; output?: readonly { type: string; text?: string }[] },
  continuable = false,
): FakeProvider {
  return {
    name,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    ...(continuable ? { prepareContinuable: async () => ({}) } : {}),
    start: async () => ({ result: Promise.resolve(result) }),
  }
}

/** A continuable provider whose epoch never settles (for the abort race). */
function pendingProvider(name = 'spawn'): FakeProvider {
  return {
    name,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    prepareContinuable: async () => ({}),
    start: async () => ({ result: new Promise(() => {}) }),
  }
}

const COMPLETED = { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] } as const

/** The two in-process providers a Task dispatch can legally name. */
function defaultProviders(
  result: { stopReason: string; output?: readonly { type: string; text?: string }[] } = COMPLETED,
): FakeProvider[] {
  return [capableProvider('spawn', result, true), capableProvider('fork', result)]
}

const tmpRoots: string[] = []

function freshWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'task-tool-'))
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

interface ToolCallResult {
  isError: boolean
  content: { type: string; text: string }[]
}

async function mount(opts: {
  routes?: { resolve(model: string | undefined): { provider?: string; model?: string } | undefined }
  seamProviders?: FakeProvider[]
  omitStartContinuable?: boolean
  withCapture?: boolean
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const emit = (event: string, info: Record<string, unknown>): void => {
    ;(ctx as unknown as { emit(event: string, info: unknown): void }).emit(event, info)
  }
  const { seam, runs, continuableStarts, startedChildIds, emitEnd } = makeSeam(opts.seamProviders ?? defaultProviders(), emit)
  if (opts.omitStartContinuable === true) delete (seam as Record<string, unknown>)['startContinuable']
  ctx.provide('subagents', seam)
  if (opts.routes !== undefined) ctx.provide('ccModelRoutes', opts.routes)
  const registry = new AgentRegistry()
  let capture: SpawnPinCapture | undefined
  let store: PinStore | undefined
  if (opts.withCapture === true) {
    const pinsRoot = mkdtempSync(join(tmpdir(), 'task-tool-pins-'))
    tmpRoots.push(pinsRoot)
    store = new PinStore(pinsRoot)
    capture = new SpawnPinCapture(ctx, store)
  }
  registerTaskTool(ctx, registry, capture)
  return { ctx, runs, continuableStarts, startedChildIds, emitEnd, registry, store }
}

let callCounter = 0
async function call(ctx: Context, args: Record<string, unknown>, agent?: Agent, signal?: AbortSignal) {
  const result = await ctx.tools.execute({
    signal: signal ?? new AbortController().signal,
    callId: `call-${++callCounter}` as never,
    name: TASK_TOOL,
    arguments: args,
    ...(agent !== undefined ? { agent } : {}),
  })
  return result as ToolCallResult
}

/** Reserve names on the host tool registry so a scoped `restrict()` accepts them. */
function reserveNames(ctx: Context, ...names: string[]): void {
  for (const name of names) ctx.tools.reserve(name)
}

/** Replace (or install) the context logger's warn with a captured vi.fn. */
function captureWarn(ctx: Context): ReturnType<typeof vi.fn> {
  const warn = vi.fn()
  const existing = (ctx as { logger?: Record<string, unknown> }).logger
  ;(ctx as { logger: Record<string, unknown> }).logger = { ...existing, warn }
  return warn
}

let restrictCounter = 0
/**
 * Mint a scoped child context (the same pattern tool-search's `mintAgent`
 * uses) and apply the filter through a real scoped `restrict()` — it must
 * NOT throw. Without this, a filter carrying an unrestrictable name would
 * only fail later at the child's own start.
 */
async function assertRestrictable(ctx: Context, filter: ToolRestriction): Promise<void> {
  // The scope key is opaque to dsh-scope; a plain unique string is a legal
  // key (SessionId branding is irrelevant to restrict()).
  const agent = { id: `restrict-${++restrictCounter}` } as Agent
  let scope!: Scope
  const fiber = ctx.plugin(Object.assign((inner: Context) => {
    scope = createScope(inner, agent)
  }, { inject: ['tools'] }))
  await fiber.await()
  try {
    expect(() => scope.ctx.tools.restrict(filter)).not.toThrow()
  } finally {
    await scope.dispose()
  }
}

describe('Task tool', () => {
  it('spawns a fresh child when subagent_type is omitted', async () => {
    const { ctx, runs, continuableStarts } = await mount()
    const result = await call(ctx, { description: 'do thing', prompt: 'task body' }, agentAt('/any'))
    expect(result.content[0]!.text).toBe('done')
    // Foreground non-fork dispatch now collects the first epoch of a
    // continuable child (Slice 2 collect refit): the one-shot seam.start is
    // fork-only.
    expect(runs).toHaveLength(0)
    expect(continuableStarts).toHaveLength(1)
    expect(continuableStarts[0]!.provider).toBe('spawn')
    expect(continuableStarts[0]!.request['persona']).toBeUndefined()
    expect(continuableStarts[0]!.request['agentOptions']).toBeUndefined()
    expect(continuableStarts[0]!.request['toolFilter']).toBeUndefined()
    expect(continuableStarts[0]!.request['prompt']).toEqual([{ type: 'text', text: 'task body' }])
  })

  it('spawns a fresh child for the general-purpose sentinel', async () => {
    const { ctx, runs, continuableStarts } = await mount()
    await call(ctx, { subagent_type: 'general-purpose', description: 'x', prompt: 'task' }, agentAt('/any'))
    expect(runs).toHaveLength(0)
    expect(continuableStarts[0]!.provider).toBe('spawn')
    expect(continuableStarts[0]!.request['persona']).toBeUndefined()
    expect(continuableStarts[0]!.request['toolFilter']).toBeUndefined()
  })

  it('spawns a fresh child for a blank subagent_type', async () => {
    const { ctx, runs, continuableStarts } = await mount()
    await call(ctx, { subagent_type: '   ', description: 'x', prompt: 'task' }, agentAt('/any'))
    expect(runs).toHaveLength(0)
    expect(continuableStarts[0]!.provider).toBe('spawn')
    expect(continuableStarts[0]!.request['persona']).toBeUndefined()
  })

  it('the fork sentinel inherits completed parent turns and never consults the registry', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'fork', '---\nname: fork\ndescription: A file named fork\n---\nUnreachable.\n')
    const { ctx, runs, registry } = await mount()
    const resolve = vi.spyOn(registry, 'resolve')
    await call(ctx, { subagent_type: 'fork', description: 'x', prompt: 'task' }, agentAt(ws))
    expect(runs[0]!.provider).toBe('fork')
    expect(runs[0]!.request['persona']).toBeUndefined()
    expect(runs[0]!.request['toolFilter']).toBeUndefined()
    expect(runs[0]!.request['prompt']).toEqual([{ type: 'text', text: 'task' }])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('dispatches a workspace definition via persona + resolved route', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'deep-reasoner', '---\nname: deep-reasoner\ndescription: Review heavy work\nmodel: opus\n---\nYou are a Staff Engineer.\n')
    const routes = { resolve: (m: string | undefined) => m === 'opus' ? { provider: 'orchestrix', model: 'glm-5.2' } : undefined }
    const { ctx, runs, continuableStarts } = await mount({ routes })
    const result = await call(ctx, { subagent_type: 'deep-reasoner', description: 'review', prompt: 'audit the doc' }, agentAt(ws))
    expect(result.content[0]!.text).toBe('done')
    expect(runs).toHaveLength(0)
    expect(continuableStarts[0]!.provider).toBe('spawn')
    const req = continuableStarts[0]!.request
    expect(req['persona']).toBe('You are a Staff Engineer.')
    expect(req['prompt']).toEqual([{ type: 'text', text: 'audit the doc' }])
    expect(req['agentOptions']).toEqual({ provider: 'orchestrix', model: 'glm-5.2' })
    expect(req['maxDepth']).toBe(3)
  })

  it('omits agentOptions when the model alias resolves to inherit', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'fast-worker', '---\nname: fast-worker\ndescription: Mechanical\nmodel: sonnet\n---\nFast.\n')
    const routes = { resolve: () => undefined }
    const { ctx, runs, continuableStarts } = await mount({ routes })
    await call(ctx, { subagent_type: 'fast-worker', description: 'x', prompt: 't' }, agentAt(ws))
    expect(runs).toHaveLength(0)
    expect(continuableStarts[0]!.request['agentOptions']).toBeUndefined()
  })

  it('stamps the alias-resolved reasoningEffort onto agentOptions', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'deep-reasoner', '---\nname: deep-reasoner\ndescription: Review heavy work\nmodel: opus\n---\nYou are a Staff Engineer.\n')
    const routes = {
      resolve: (m: string | undefined) => m === 'opus'
        ? { provider: 'orchestrix', model: 'glm-5.3', reasoningEffort: 'max' }
        : undefined,
    }
    const { ctx, runs, continuableStarts } = await mount({ routes })
    await call(ctx, { subagent_type: 'deep-reasoner', description: 'review', prompt: 'audit' }, agentAt(ws))
    expect(runs).toHaveLength(0)
    expect(continuableStarts[0]!.request['agentOptions']).toEqual({
      provider: 'orchestrix',
      model: 'glm-5.3',
      reasoningEffort: 'max',
    })
  })

  it('stamps effort for a provider-less route (provider omitted from agentOptions)', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'fast-worker', '---\nname: fast-worker\ndescription: Mechanical\nmodel: sonnet\n---\nFast.\n')
    const routes = {
      resolve: (m: string | undefined) => m === 'sonnet'
        ? { model: 'glm-5.3-flash', reasoningEffort: 'max' }
        : undefined,
    }
    const { ctx, runs, continuableStarts } = await mount({ routes })
    await call(ctx, { subagent_type: 'fast-worker', description: 'x', prompt: 't' }, agentAt(ws))
    expect(continuableStarts[0]!.request['agentOptions']).toEqual({ model: 'glm-5.3-flash', reasoningEffort: 'max' })
  })

  it('inherit still omits agentOptions entirely even when a sibling alias carries effort', async () => {
    const ws = freshWorkspace()
    // fast-worker resolves to inherit; the effort-carrying alias is never consulted.
    writeAgent(ws, 'fast-worker', '---\nname: fast-worker\ndescription: Mechanical\nmodel: sonnet\n---\nFast.\n')
    const routes = {
      resolve: (m: string | undefined) => m === 'opus'
        ? { provider: 'orchestrix', model: 'glm-5.3', reasoningEffort: 'max' }
        : undefined,
    }
    const { ctx, runs, continuableStarts } = await mount({ routes })
    await call(ctx, { subagent_type: 'fast-worker', description: 'x', prompt: 't' }, agentAt(ws))
    expect(continuableStarts[0]!.request['agentOptions']).toBeUndefined()
  })

  it('works when no ccModelRoutes service is mounted', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'plain', '---\nname: plain\ndescription: No model\n---\nPlain.\n')
    const { ctx, runs, continuableStarts } = await mount()
    const result = await call(ctx, { subagent_type: 'plain', description: 'x', prompt: 't' }, agentAt(ws))
    expect(result.content[0]!.text).toBe('done')
    expect(runs).toHaveLength(0)
    expect(continuableStarts[0]!.request['persona']).toBe('Plain.')
  })

  it('errors with the available type list for an unknown subagent_type', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'deep-reasoner', '---\nname: deep-reasoner\ndescription: Review\n---\nBody.\n')
    const { ctx, runs, continuableStarts } = await mount()
    const first = await call(ctx, { subagent_type: 'nope', description: 'x', prompt: 't' }, agentAt(ws))
    expect(first.isError).toBe(true)
    expect(first.content[0]!.text).toMatch(/unknown subagent_type "nope"/)
    expect(first.content[0]!.text).toMatch(/deep-reasoner/)
    expect(first.content[0]!.text).toMatch(/explore/)
    expect(runs).toHaveLength(0)
    expect(continuableStarts).toHaveLength(0)
  })

  it('dispatches the bundled explore agent on a bare workspace with haiku route stamps', async () => {
    const ws = freshWorkspace()
    const routes = { resolve: (m: string | undefined) => m === 'haiku' ? { provider: 'p', model: 'cheap' } : undefined }
    const { ctx, runs, continuableStarts } = await mount({ routes })
    reserveNames(ctx, 'read', 'read_image', 'glob', 'grep')
    const result = await call(ctx, { subagent_type: 'explore', description: 'find it', prompt: 'where is X defined?' }, agentAt(ws))
    expect(result.content[0]!.text).toBe('done')
    expect(runs).toHaveLength(0)
    expect(continuableStarts[0]!.request['agentOptions']).toEqual({ provider: 'p', model: 'cheap' })
    expect(continuableStarts[0]!.request['persona']).toContain('read-only codebase scout')
    const filter = continuableStarts[0]!.request['toolFilter'] as { allow?: string[] } | undefined
    expect(filter?.allow).toEqual(expect.arrayContaining(['read', 'read_image', 'glob', 'grep']))
    expect(filter?.allow?.includes('write')).toBe(false)
    await assertRestrictable(ctx, filter as ToolRestriction)
  })

  it('omits agentOptions for a bundled agent when the alias does not resolve', async () => {
    const ws = freshWorkspace()
    const routes = { resolve: () => undefined }
    const { ctx, runs, continuableStarts } = await mount({ routes })
    reserveNames(ctx, 'read', 'read_image', 'glob', 'grep')
    await call(ctx, { subagent_type: 'explore', description: 'x', prompt: 't' }, agentAt(ws))
    expect(runs).toHaveLength(0)
    expect(continuableStarts[0]!.request['agentOptions']).toBeUndefined()
  })

  it('maps a child failure stopReason to an isError result', async () => {
    const seamProviders = defaultProviders({ stopReason: 'error' })
    const { ctx } = await mount({ seamProviders })
    const result = await call(ctx, { description: 'x', prompt: 't' }, agentAt('/any'))
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/run failed.*stopReason "error"/s)
  })

  it('extracts only text blocks from the child output', async () => {
    const seamProviders = defaultProviders({ stopReason: 'completed', output: [
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'answer A' },
      { type: 'text', text: ' answer B' },
    ] })
    const { ctx } = await mount({ seamProviders })
    const result = await call(ctx, { description: 'x', prompt: 't' }, agentAt('/any'))
    expect(result.content[0]!.text).toBe('answer A answer B')
  })

  it('keeps reserved and registered names in a definition toolFilter', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'guarded', '---\nname: guarded\ndescription: With tools\ntools: [Read, Task, Bash]\n---\nGuarded.\n')
    // `Task` translates to ['subagent', 'subagent_fork']; `subagent` is
    // reserved by registerTaskTool and `subagent_fork` is the registered Task
    // tool. `read`/`read_image`/`bash` must be mounted (registered or
    // reserved) or sanitization drops them — here they are reserved, as the
    // cc preset registers them.
    const { ctx, runs, continuableStarts } = await mount()
    reserveNames(ctx, 'read', 'read_image', 'bash')
    await call(ctx, { subagent_type: 'guarded', description: 'x', prompt: 't' }, agentAt(ws))
    expect(runs).toHaveLength(0)
    expect(continuableStarts).toHaveLength(1)
    const filter = continuableStarts[0]!.request['toolFilter'] as { allow?: string[]; deny?: string[] } | undefined
    expect(filter?.allow).toBeDefined()
    expect(filter?.allow).toContain('read')
    expect(filter?.allow).toContain('read_image')
    expect(filter?.allow).toContain('subagent')
    expect(filter?.allow).toContain('subagent_fork')
    expect(filter?.allow).toContain('bash')
    await assertRestrictable(ctx, filter!)
  })

  it('drops a frontmatter name that is not mounted (typo defence)', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'typoed', '---\nname: typoed\ndescription: Typo\ntools: [Read, Tas]\n---\nTypo.\n')
    const { ctx, runs, continuableStarts } = await mount()
    reserveNames(ctx, 'read', 'read_image')
    await call(ctx, { subagent_type: 'typoed', description: 'x', prompt: 't' }, agentAt(ws))
    const filter = continuableStarts[0]!.request['toolFilter'] as { allow?: string[]; deny?: string[] } | undefined
    expect(filter?.allow).toEqual(['read', 'read_image'])
  })

  it('keeps an exact mounted MCP public name and auto-includes mounted ToolSearch', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'mcp-user', '---\nname: mcp-user\ndescription: MCP\ntools: [Read, mcp__github__create_issue]\n---\nMCP.\n')
    const { ctx, runs, continuableStarts } = await mount()
    reserveNames(ctx, 'mcp__github__create_issue', 'mcp__github__search', 'read', 'read_image', 'ToolSearch')
    const warn = captureWarn(ctx)
    await call(ctx, { subagent_type: 'mcp-user', description: 'x', prompt: 't' }, agentAt(ws))
    const filter = continuableStarts[0]!.request['toolFilter'] as { allow?: string[]; deny?: string[] } | undefined
    expect(filter?.allow).toContain('read')
    expect(filter?.allow).toContain('read_image')
    expect(filter?.allow).toContain('mcp__github__create_issue')
    expect(filter?.allow).toContain('ToolSearch')
    expect(filter?.allow).not.toContain('mcp__github__search')
    // The spawn-time preload step warns once when no toolSearch seam is
    // mounted (it cannot pre-activate the deferred MCP name); what must stay
    // silent is sanitization — no unknown-name drops for these mounted names.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('dropping unknown tool name'))
    await assertRestrictable(ctx, filter!)
  })

  it('expands server-level MCP wildcards in both forms and auto-includes mounted ToolSearch', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'wild-a', '---\nname: wild-a\ndescription: A\ntools: [mcp__github]\n---\nA.\n')
    writeAgent(ws, 'wild-b', '---\nname: wild-b\ndescription: B\ntools: [mcp__github__*]\n---\nB.\n')
    const { ctx, runs, continuableStarts } = await mount()
    reserveNames(ctx, 'mcp__github__create_issue', 'mcp__github__search', 'ToolSearch')
    await call(ctx, { subagent_type: 'wild-a', description: 'x', prompt: 't' }, agentAt(ws))
    await call(ctx, { subagent_type: 'wild-b', description: 'x', prompt: 't' }, agentAt(ws))
    for (const start of continuableStarts) {
      const filter = start.request['toolFilter'] as { allow?: string[] } | undefined
      expect(filter?.allow).toContain('mcp__github__create_issue')
      expect(filter?.allow).toContain('mcp__github__search')
      expect(filter?.allow).toContain('ToolSearch')
      await assertRestrictable(ctx, filter as ToolRestriction)
    }
  })

  it('sees MCP names reserved on an ancestor standing-scope layer', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'mcp-user', '---\nname: mcp-user\ndescription: MCP\ntools: [mcp__github__create_issue]\n---\nMCP.\n')
    const { ctx, runs, continuableStarts } = await mount()
    // Production shape: mcp-client registers on the cc standing-scope layer,
    // and the calling session agent is a child of that standing key. `view()`
    // without the calling agent only sees the global layer and would drop
    // those names.
    const standingKey = { id: 'standing' } as Agent
    const caller = agentAt(ws)
    let standing!: Scope
    let child!: Scope
    const fiber = ctx.plugin(Object.assign((inner: Context) => {
      standing = createScope(inner, standingKey)
      child = createScope(inner, caller, { parent: standingKey })
    }, { inject: ['tools'] }))
    await fiber.await()
    standing.ctx.tools.reserve('mcp__github__create_issue')
    standing.ctx.tools.reserve('ToolSearch')
    await call(ctx, { subagent_type: 'mcp-user', description: 'x', prompt: 't' }, caller)
    const filter = continuableStarts[0]!.request['toolFilter'] as { allow?: string[]; deny?: string[] } | undefined
    expect(filter?.allow).toContain('mcp__github__create_issue')
    expect(filter?.allow).toContain('ToolSearch')
    await child.dispose()
    await standing.dispose()
  })

  it('never auto-includes ToolSearch when it is not mounted', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'mcp-user', '---\nname: mcp-user\ndescription: MCP\ntools: [mcp__github__create_issue]\n---\nMCP.\n')
    const { ctx, runs, continuableStarts } = await mount()
    reserveNames(ctx, 'mcp__github__create_issue')
    await call(ctx, { subagent_type: 'mcp-user', description: 'x', prompt: 't' }, agentAt(ws))
    const filter = continuableStarts[0]!.request['toolFilter'] as { allow?: string[]; deny?: string[] } | undefined
    expect(filter?.allow).toContain('mcp__github__create_issue')
    expect(filter?.allow).not.toContain('ToolSearch')
    await assertRestrictable(ctx, filter!)
  })

  it('emits a deny-all allow list (with a warning) when the allow-list matches no mounted tools', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'missing', '---\nname: missing\ndescription: M\ntools: [mcp__missing__foo]\n---\nM.\n')
    const { ctx, runs, continuableStarts } = await mount()
    const warn = captureWarn(ctx)
    await call(ctx, { subagent_type: 'missing', description: 'x', prompt: 't' }, agentAt(ws))
    const filter = continuableStarts[0]!.request['toolFilter'] as { allow?: string[]; deny?: string[] } | undefined
    expect(filter).toEqual({ allow: [] })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mcp__missing__foo'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no mounted tools'))
    await assertRestrictable(ctx, filter!)
  })

  it('keeps a mounted MCP name in a disallowedTools deny-list', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'mcp-denied', '---\nname: mcp-denied\ndescription: D\ndisallowedTools: [mcp__github__search]\n---\nD.\n')
    const { ctx, runs, continuableStarts } = await mount()
    reserveNames(ctx, 'mcp__github__search')
    await call(ctx, { subagent_type: 'mcp-denied', description: 'x', prompt: 't' }, agentAt(ws))
    const filter = continuableStarts[0]!.request['toolFilter'] as { allow?: string[]; deny?: string[] } | undefined
    expect(filter?.deny).toContain('mcp__github__search')
    await assertRestrictable(ctx, filter!)
  })

  it('passes no toolFilter when the definition declares no tools key', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'plain', '---\nname: plain\ndescription: P\n---\nP.\n')
    const { ctx, runs, continuableStarts } = await mount()
    await call(ctx, { subagent_type: 'plain', description: 'x', prompt: 't' }, agentAt(ws))
    expect(runs).toHaveLength(0)
    expect(continuableStarts[0]!.request['toolFilter']).toBeUndefined()
  })

  it('rejects a bare mcp__ wildcard with a deny-all allow list', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'bare', '---\nname: bare\ndescription: B\ntools: [mcp__]\n---\nB.\n')
    const { ctx, runs, continuableStarts } = await mount()
    const warn = captureWarn(ctx)
    await call(ctx, { subagent_type: 'bare', description: 'x', prompt: 't' }, agentAt(ws))
    const filter = continuableStarts[0]!.request['toolFilter'] as { allow?: string[]; deny?: string[] } | undefined
    expect(filter).toEqual({ allow: [] })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid MCP wildcard'))
    await assertRestrictable(ctx, filter!)
  })

  it('requires a calling agent', async () => {
    const { ctx } = await mount()
    const result = await call(ctx, { description: 'x', prompt: 't' })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/agent/)
  })

  describe('run_in_background', () => {
    it('starts a continuable child on spawn and returns the durable id without awaiting a result', async () => {
      const { ctx, runs, continuableStarts } = await mount()
      const result = await call(ctx, {
        description: 'long work',
        prompt: 'grind in the background',
        run_in_background: true,
      }, agentAt('/any'))
      expect(result.isError).toBe(false)
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(1)
      const start = continuableStarts[0]!
      expect(start.provider).toBe('spawn')
      expect(start.label).toBe('long work')
      expect(start.request['prompt']).toEqual([{ type: 'text', text: 'grind in the background' }])
      expect(start.request['maxDepth']).toBe(3)
      expect(start.request['persona']).toBeUndefined()
      expect(start.request['agentOptions']).toBeUndefined()
      expect(start.request['toolFilter']).toBeUndefined()
      expect(result.content[0]!.text).toContain('child-1')
      expect(result.content[0]!.text).toContain('list_agents')
      expect(result.content[0]!.text).toContain('send_message')
      expect(result.content[0]!.text).toContain('interrupt_agent')
      expect(JSON.stringify(result)).not.toContain('outputFile')
    })

    it('folds a named definition exactly like the foreground path into the continuable request', async () => {
      const ws = freshWorkspace()
      writeAgent(ws, 'deep-reasoner', '---\nname: deep-reasoner\ndescription: Review heavy work\nmodel: opus\ntools: [Read, Bash]\n---\nYou are a Staff Engineer.\n')
      const routes = { resolve: (m: string | undefined) => m === 'opus' ? { provider: 'orchestrix', model: 'glm-5.2' } : undefined }
      const { ctx, runs, continuableStarts } = await mount({ routes })
      reserveNames(ctx, 'read', 'bash')
      await call(ctx, {
        subagent_type: 'deep-reasoner',
        description: 'review',
        prompt: 'audit the doc',
        run_in_background: true,
      }, agentAt(ws))
      expect(runs).toHaveLength(0)
      expect(continuableStarts[0]!.provider).toBe('spawn')
      const req = continuableStarts[0]!.request
      expect(req['persona']).toBe('You are a Staff Engineer.')
      expect(req['prompt']).toEqual([{ type: 'text', text: 'audit the doc' }])
      expect(req['agentOptions']).toEqual({ provider: 'orchestrix', model: 'glm-5.2' })
      expect(req['maxDepth']).toBe(3)
      const filter = req['toolFilter'] as { allow?: string[] }
      expect(filter.allow).toEqual(expect.arrayContaining(['read', 'bash']))
      await assertRestrictable(ctx, filter as ToolRestriction)
    })

    it('rejects fork + background before touching the seam, naming issue #2124 and the workaround', async () => {
      const { ctx, runs, continuableStarts } = await mount()
      const result = await call(ctx, {
        subagent_type: 'fork',
        description: 'x',
        prompt: 't',
        run_in_background: true,
      }, agentAt('/any'))
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toMatch(/2124/)
      expect(result.content[0]!.text).toMatch(/run_in_background|background/)
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(0)
    })

    it('errors with the available type list for an unknown background type', async () => {
      const ws = freshWorkspace()
      writeAgent(ws, 'deep-reasoner', '---\nname: deep-reasoner\ndescription: Review\n---\nBody.\n')
      const { ctx, runs, continuableStarts } = await mount()
      const result = await call(ctx, {
        subagent_type: 'nope',
        description: 'x',
        prompt: 't',
        run_in_background: true,
      }, agentAt(ws))
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toMatch(/unknown subagent_type "nope"/)
      expect(result.content[0]!.text).toMatch(/deep-reasoner/)
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(0)
    })

    it('maps a provider without prepareContinuable to an actionable capability error', async () => {
      const seamProviders = defaultProviders().map(p =>
        p.name === 'spawn' ? { ...p, prepareContinuable: undefined } : p,
      )
      const { ctx, runs, continuableStarts } = await mount({ seamProviders })
      const result = await call(ctx, { description: 'x', prompt: 't', run_in_background: true }, agentAt('/any'))
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toMatch(/UNSUPPORTED_CAPABILITY/)
      expect(result.content[0]!.text).toMatch(/background subagent/i)
      expect(result.content[0]!.text).toMatch(/prepareContinuable|capability/i)
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(0)
    })

    it('maps a seam without startContinuable to an actionable capability error', async () => {
      const { ctx, runs } = await mount({ omitStartContinuable: true })
      const result = await call(ctx, { description: 'x', prompt: 't', run_in_background: true }, agentAt('/any'))
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toMatch(/background subagent/i)
      expect(result.content[0]!.text).toMatch(/capabilit|continuable/i)
      expect(runs).toHaveLength(0)
    })

    it('keeps the foreground path byte-identical when run_in_background is absent or false and the definition does not pin background', async () => {
      const { ctx, runs, continuableStarts } = await mount()
      const omitted = await call(ctx, { description: 'x', prompt: 't' }, agentAt('/any'))
      const explicitFalse = await call(ctx, { description: 'x', prompt: 't', run_in_background: false }, agentAt('/any'))
      // Slice 2 collect refit: both omissions collect the first epoch of a
      // continuable child inline — same continuable substrate as background.
      expect(omitted.content[0]!.text).toBe('done')
      expect(explicitFalse.content[0]!.text).toBe('done')
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(2)
      expect(continuableStarts.every(s => s.provider === 'spawn')).toBe(true)
    })

    it('renders the background contract text naming the durable id and the control loop', async () => {
      const { ctx } = await mount()
      const result = await call(ctx, { description: 'x', prompt: 't', run_in_background: true }, agentAt('/any'))
      const text = result.content[0]!.text
      expect(text).toContain('child-1')
      expect(text).toMatch(/wak(e|ing)|finish/)
      expect(text).toMatch(/list_agents/)
      expect(text).toMatch(/send_message/)
      expect(text).toMatch(/interrupt_agent/)
      expect(text.toLowerCase()).not.toContain('outputfile')
    })

    it('starts the bundled explore agent in the background with its persona and read-only allow-list', async () => {
      const ws = freshWorkspace()
      const routes = { resolve: (m: string | undefined) => m === 'haiku' ? { provider: 'p', model: 'cheap' } : undefined }
      const { ctx, runs, continuableStarts } = await mount({ routes })
      reserveNames(ctx, 'read', 'read_image', 'glob', 'grep')
      await call(ctx, {
        subagent_type: 'explore',
        description: 'find it',
        prompt: 'where is X?',
        run_in_background: true,
      }, agentAt(ws))
      expect(runs).toHaveLength(0)
      expect(continuableStarts[0]!.provider).toBe('spawn')
      const req = continuableStarts[0]!.request
      expect(req['persona']).toContain('read-only codebase scout')
      expect(req['agentOptions']).toEqual({ provider: 'p', model: 'cheap' })
      const filter = req['toolFilter'] as { allow?: string[] }
      expect(filter.allow).toEqual(expect.arrayContaining(['read', 'read_image', 'glob', 'grep']))
      expect(filter.allow?.includes('write')).toBe(false)
      await assertRestrictable(ctx, filter as ToolRestriction)
    })
  })

  describe('definition.background pin', () => {
    it('backgrounds on omit when the definition pins background: true, folding the persona', async () => {
      const ws = freshWorkspace()
      writeAgent(ws, 'scout', '---\nname: scout\ndescription: Pinned to background\nbackground: true\n---\nYou are a pinned scout.\n')
      const { ctx, runs, continuableStarts } = await mount()
      await call(ctx, { subagent_type: 'scout', description: 'pinned', prompt: 'grind' }, agentAt(ws))
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(1)
      expect(continuableStarts[0]!.provider).toBe('spawn')
      expect(continuableStarts[0]!.request['persona']).toBe('You are a pinned scout.')
      expect(continuableStarts[0]!.request['prompt']).toEqual([{ type: 'text', text: 'grind' }])
    })

    it('explicit run_in_background: false wins over the pin and keeps the foreground path', async () => {
      const ws = freshWorkspace()
      writeAgent(ws, 'scout', '---\nname: scout\ndescription: Pinned to background\nbackground: true\n---\nYou are a pinned scout.\n')
      const { ctx, runs, continuableStarts } = await mount()
      const result = await call(ctx, { subagent_type: 'scout', description: 'pinned', prompt: 't', run_in_background: false }, agentAt(ws))
      expect(result.content[0]!.text).toBe('done')
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(1)
      expect(continuableStarts[0]!.provider).toBe('spawn')
      expect(continuableStarts[0]!.request['persona']).toBe('You are a pinned scout.')
    })

    it('explicit run_in_background: true also backgrounds a pinned definition', async () => {
      const ws = freshWorkspace()
      writeAgent(ws, 'scout', '---\nname: scout\ndescription: Pinned to background\nbackground: true\n---\nYou are a pinned scout.\n')
      const { ctx, runs, continuableStarts } = await mount()
      await call(ctx, { subagent_type: 'scout', description: 'pinned', prompt: 't', run_in_background: true }, agentAt(ws))
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(1)
      expect(continuableStarts[0]!.request['persona']).toBe('You are a pinned scout.')
    })

    it('a definition without the background field stays foreground on omit', async () => {
      const ws = freshWorkspace()
      writeAgent(ws, 'plain', '---\nname: plain\ndescription: No pin\n---\nPlain body.\n')
      const { ctx, runs, continuableStarts } = await mount()
      await call(ctx, { subagent_type: 'plain', description: 'x', prompt: 't' }, agentAt(ws))
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(1)
      expect(continuableStarts[0]!.provider).toBe('spawn')
    })

    it('the bundled explore agent stays foreground on omit (no pin)', async () => {
      const ws = freshWorkspace()
      const { ctx, runs, continuableStarts } = await mount()
      await call(ctx, { subagent_type: 'explore', description: 'find it', prompt: 'where is X?' }, agentAt(ws))
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(1)
      expect(continuableStarts[0]!.provider).toBe('spawn')
      expect(continuableStarts[0]!.request['persona']).toContain('read-only codebase scout')
    })

    it('general-purpose with omit stays foreground (no definition to pin)', async () => {
      const { ctx, runs, continuableStarts } = await mount()
      await call(ctx, { subagent_type: 'general-purpose', description: 'x', prompt: 't' }, agentAt('/any'))
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(1)
    })

    it('registers the prompt contract: background section carries the human heuristic and the pin escape hatch', () => {
      expect(BACKGROUND_SECTION_TEXT).toMatch(/run_in_background: true/)
      expect(BACKGROUND_SECTION_TEXT).toMatch(/run_in_background: false/)
      expect(BACKGROUND_SECTION_TEXT).toMatch(/background: true/)
      expect(BACKGROUND_SECTION_TEXT).toMatch(/## Background subagents/)
      expect(BACKGROUND_SECTION_TEXT.toLowerCase()).not.toContain('foreground by default')
      expect(BACKGROUND_SECTION_TEXT.toLowerCase()).not.toContain('long-running or parallelizable')
    })

    it('registers the tool description and parameter description with the same contract', async () => {
      const { ctx } = await mount()
      const def = ctx.tools.get(TASK_TOOL) as unknown as { description: string; parameters: { properties: Record<string, { description: string }> } } | undefined
      expect(def).toBeDefined()
      expect(def!.description.toLowerCase()).not.toContain('foreground by default')
      expect(def!.description.toLowerCase()).not.toContain('long-running or parallelizable')
      expect(def!.description).toMatch(/run_in_background/)
      expect(def!.description).toMatch(/background: true|definition/)
      const param = def!.parameters.properties['run_in_background']
      expect(param).toBeDefined()
      expect(param.description.toLowerCase()).not.toContain('default false')
      expect(param.description).toMatch(/false|pin/)
    })
  })

  describe('foreground collect through the epoch collector', () => {
    it('collects the first epoch inline from the continuable child (no one-shot start)', async () => {
      const { ctx, runs, continuableStarts } = await mount()
      const result = await call(ctx, { description: 'x', prompt: 't' }, agentAt('/any'))
      expect(result.content[0]!.text).toBe('done')
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(1)
      expect(continuableStarts[0]!.request['prompt']).toEqual([{ type: 'text', text: 't' }])
    })

    it('pins per-reason stop-reason messages (max-tokens / refusal / aborted)', async () => {
      for (const [stopReason, pattern] of [
        ['max-tokens', /stopped with reason "max-tokens".*token ceiling/s],
        ['refusal', /stopped with reason "refusal".*declined the task/s],
        ['aborted', /was interrupted \(stopReason "aborted"\).*may still be resumed/s],
      ] as const) {
        const seamProviders = defaultProviders({ stopReason, output: [{ type: 'text', text: 'x' }] })
        const { ctx } = await mount({ seamProviders })
        const result = await call(ctx, { description: 'x', prompt: 't' }, agentAt('/any'))
        expect(result.isError).toBe(true)
        expect(result.content[0]!.text).toMatch(pattern)
      }
    })

    it('keeps the fork path on the one-shot seam (collect refit does not touch fork)', async () => {
      const seamProviders = defaultProviders({ stopReason: 'error' })
      const { ctx, runs, continuableStarts } = await mount({ seamProviders })
      const result = await call(ctx, { subagent_type: 'fork', description: 'x', prompt: 't' }, agentAt('/any'))
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toMatch(/stopped with reason "error"/)
      expect(runs).toHaveLength(1)
      expect(continuableStarts).toHaveLength(0)
    })

    it('maps exec.signal abort to exactly-one interrupt and a prompt synthetic aborted result', async () => {
      const ac = new AbortController()
      const { ctx, startedChildIds, emitEnd } = await mount({ seamProviders: [pendingProvider()] })
      const interrupts: [string, unknown][] = []
      const seam = ctx.get('subagents') as Record<string, unknown>
      seam['interrupt'] = (childId: string, authority: unknown) => {
        interrupts.push([childId, authority])
      }
      const pending = call(ctx, { description: 'x', prompt: 't' }, agentAt('/any'), ac.signal)
      // Let the collect reserve + start, then abort (Esc).
      await new Promise(resolve => setTimeout(resolve, 10))
      ac.abort()
      const result = await pending
      // Prompt synthetic resolution — the never-settling epoch never resolved.
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toMatch(/interrupted.*may still be resumed/s)
      expect(interrupts).toEqual([
        [startedChildIds[0], { kind: 'ancestor', agent: expect.objectContaining({ session: expect.anything() }) }],
      ])
      expect(interrupts[0]![1]).toMatchObject({ kind: 'ancestor' })
      // The real terminal arrives later; the tool call is already resolved.
      emitEnd(startedChildIds[0]!, { stopReason: 'aborted' })
    })

    it('degrades observably when the seam lacks interrupt (prompt resolve, no hang, no silent success)', async () => {
      const ac = new AbortController()
      const { ctx, startedChildIds, emitEnd } = await mount({ seamProviders: [pendingProvider()] })
      const pending = call(ctx, { description: 'x', prompt: 't' }, agentAt('/any'), ac.signal)
      await new Promise(resolve => setTimeout(resolve, 10))
      ac.abort()
      const result = await pending
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toMatch(/interrupted/)
      // The real terminal arrives later and releases the armed watcher entry.
      emitEnd(startedChildIds[0]!, { stopReason: 'aborted' })
    })
  })

  describe('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS kill switch', () => {
    const PARSING: [string | undefined, boolean][] = [
      [undefined, false],
      ['', false],
      ['0', false],
      ['false', false],
      ['FALSE', false],
      ['False', false],
      ['1', true],
      ['true', true],
      ['TRUE', true],
      ['yes', true],
      [' ', true],
    ]
    it.each(PARSING)('parses CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=%p as %p', (value, expected) => {
      const env = value === undefined ? {} : { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: value }
      expect(backgroundTasksDisabled(env)).toBe(expected)
    })

    it('disables the definition pin (omissions collect in foreground) but honors explicit arguments', async () => {
      const prev = process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
      process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'
      try {
        const ws = freshWorkspace()
        writeAgent(ws, 'scout', '---\nname: scout\ndescription: Pinned\nbackground: true\n---\nPinned scout.\n')
        const { ctx, runs, continuableStarts } = await mount()
        // Pin ignored: omit collects in foreground (inline result).
        const omitted = await call(ctx, { subagent_type: 'scout', description: 'x', prompt: 't' }, agentAt(ws))
        expect(omitted.content[0]!.text).toBe('done')
        expect(runs).toHaveLength(0)
        expect(continuableStarts).toHaveLength(1)
        // Explicit true still honored both ways.
        const explicit = await call(ctx, { subagent_type: 'scout', description: 'x', prompt: 't', run_in_background: true }, agentAt(ws))
        expect(explicit.content[0]!.text).toContain('Background subagent started')
        expect(continuableStarts).toHaveLength(2)
        // Explicit false still foreground.
        const forced = await call(ctx, { subagent_type: 'scout', description: 'x', prompt: 't', run_in_background: false }, agentAt(ws))
        expect(forced.content[0]!.text).toBe('done')
        expect(continuableStarts).toHaveLength(3)
      } finally {
        if (prev === undefined) delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
        else process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = prev
      }
    })
  })

  describe('plugin agent dispatch (scoped plugin:agent ids)', () => {
    function mountWithPlugin(opts: Parameters<typeof mount>[0] & { pluginDefs?: Parameters<typeof pluginProvider>[1][] } = {}) {
      const plugins = (opts.pluginDefs ?? [{}]).map((def, i) => pluginProvider(`p:researcher${i > 0 ? i : ''}`, def))
      return mount({ ...opts, seamProviders: [...defaultProviders(), ...plugins, ...(opts.seamProviders ?? [])] })
    }

    it('folds persona/toolFilter/agentOptions/maxDepth into the recorded spawn start request', async () => {
      const routes = { resolve: (m: string | undefined) => m === 'opus' ? { provider: 'orchestrix', model: 'glm-5.2' } : undefined }
      const { ctx, runs, continuableStarts } = await mountWithPlugin({
        routes,
        withCapture: false,
        pluginDefs: [{ systemPrompt: 'You are the plugin researcher.', toolRestriction: { allow: ['read'] }, model: 'opus' }],
      })
      reserveNames(ctx, 'read')
      const result = await call(ctx, {
        subagent_type: 'p:researcher',
        description: 'review',
        prompt: 'audit the doc',
        run_in_background: true,
      }, agentAt('/any'))
      expect(result.isError).toBe(false)
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(1)
      expect(continuableStarts[0]!.provider).toBe('spawn')
      const req = continuableStarts[0]!.request
      expect(req['persona']).toBe('You are the plugin researcher.')
      expect(req['prompt']).toEqual([{ type: 'text', text: 'audit the doc' }])
      expect(req['agentOptions']).toEqual({ provider: 'orchestrix', model: 'glm-5.2' })
      expect(req['maxDepth']).toBe(3)
      const filter = req['toolFilter'] as { allow?: string[] }
      expect(filter.allow).toContain('read')
      await assertRestrictable(ctx, filter as ToolRestriction)
    })

    it('backgrounds on omit when the plugin definition pins background: true', async () => {
      const { ctx, runs, continuableStarts } = await mountWithPlugin({
        pluginDefs: [{ systemPrompt: 'Pinned plugin scout.', background: true }],
      })
      await call(ctx, { subagent_type: 'p:researcher', description: 'pinned', prompt: 'grind' }, agentAt('/any'))
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(1)
      expect(continuableStarts[0]!.provider).toBe('spawn')
      expect(continuableStarts[0]!.request['persona']).toBe('Pinned plugin scout.')
    })

    it('returns the collected text for a foreground plugin dispatch', async () => {
      const { ctx, runs, continuableStarts } = await mountWithPlugin({
        pluginDefs: [{ systemPrompt: 'Foreground plugin.' }],
      })
      const result = await call(ctx, { subagent_type: 'p:researcher', description: 'x', prompt: 't' }, agentAt('/any'))
      expect(result.content[0]!.text).toBe('done')
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(1)
      expect(continuableStarts[0]!.provider).toBe('spawn')
      expect(continuableStarts[0]!.request['persona']).toBe('Foreground plugin.')
    })

    it('does not resolve a bare plugin agent name', async () => {
      const { ctx, continuableStarts } = await mountWithPlugin({ pluginDefs: [{ systemPrompt: 'x' }] })
      const result = await call(ctx, { subagent_type: 'researcher', description: 'x', prompt: 't' }, agentAt('/any'))
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toMatch(/unknown subagent_type "researcher"/)
      expect(continuableStarts).toHaveLength(0)
    })

    it('lists plugin scoped ids and the colon hint for an unknown plugin type', async () => {
      const { ctx, continuableStarts } = await mountWithPlugin({ pluginDefs: [{ systemPrompt: 'x' }] })
      const result = await call(ctx, { subagent_type: 'p:nope', description: 'x', prompt: 't' }, agentAt('/any'))
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toMatch(/unknown subagent_type "p:nope"/)
      expect(result.content[0]!.text).toContain('p:researcher')
      expect(result.content[0]!.text).toMatch(/plugin agent not found — the plugin may be unmounted or the agent renamed/)
      expect(continuableStarts).toHaveLength(0)
    })

    it('a file definition and a plugin scoped id coexist', async () => {
      const ws = freshWorkspace()
      writeAgent(ws, 'deep-reasoner', '---\nname: deep-reasoner\ndescription: Review heavy work\n---\nYou are a Staff Engineer.\n')
      const { ctx, continuableStarts } = await mountWithPlugin({
        pluginDefs: [{ systemPrompt: 'You are the plugin researcher.' }],
      })
      await call(ctx, { subagent_type: 'deep-reasoner', description: 'x', prompt: 't' }, agentAt(ws))
      await call(ctx, { subagent_type: 'p:researcher', description: 'x', prompt: 't' }, agentAt(ws))
      expect(continuableStarts).toHaveLength(2)
      expect(continuableStarts[0]!.request['persona']).toBe('You are a Staff Engineer.')
      expect(continuableStarts[1]!.request['persona']).toBe('You are the plugin researcher.')
    })

    it('a backgrounded plugin agent\u2019s resume-pin write succeeds with the plugin definition', async () => {
      const { ctx, continuableStarts, startedChildIds, store } = await mountWithPlugin({
        withCapture: true,
        pluginDefs: [{ systemPrompt: 'You are the pinned plugin researcher.' }],
      })
      // The caller carries an explicit route so the pin's route overlay is
      // materializable (no llm service → the preflight degrades gracefully).
      const caller = {
        id: 'pin-parent',
        options: { provider: 'orchestrix', model: 'glm-5.2' },
        session: { header: { cwd: '/any' } },
      } as unknown as Agent
      const result = await call(ctx, {
        subagent_type: 'p:researcher',
        description: 'pinned',
        prompt: 'grind',
        run_in_background: true,
      }, caller)
      expect(result.isError).toBe(false)
      expect(continuableStarts).toHaveLength(1)
      // The durable child id is handed out by startContinuable (the pin was
      // preallocated to it before the creation call).
      const childId = startedChildIds[0]
      expect(childId).toBeDefined()
      const pin = store!.read(childId!)
      expect(pin).toBeDefined()
      expect((pin as { definition?: { kind: string; agentType: string; source: string; baseDir: string } }).definition)
        .toMatchObject({ kind: 'named', agentType: 'researcher', source: 'project', baseDir: '/plugins/p/agents' })
      expect(result.content[0]!.text).not.toContain('resume pin capture failed')
    })

    it('teaches plugin scoped ids in the tool and parameter descriptions', async () => {
      const { ctx } = await mountWithPlugin()
      const def = ctx.tools.get(TASK_TOOL) as unknown as { description: string; parameters: { properties: Record<string, { description: string }> } }
      expect(def.description).toMatch(/plugin:agent/)
      expect(def.parameters.properties['subagent_type']!.description).toMatch(/plugin:agent/)
    })
  })

  describe('capacity guard (25 live continuable children)', () => {
    function childRow(activity: string): { kind: string; activity: string } {
      return { kind: 'child', activity }
    }
    function withListChildren(rows: { kind: string; activity?: string }[]): { seam: Record<string, unknown>; listChildren: ReturnType<typeof vi.fn> } {
      const listChildren = vi.fn(async () => rows)
      return { seam: { listChildren }, listChildren }
    }

    it('refuses a background start at 25 running children with the actionable error', async () => {
      const { ctx } = await mount()
      const rows = Array.from({ length: 25 }, () => childRow('running'))
      const { listChildren } = withListChildren(rows)
      const seam = ctx.get('subagents') as Record<string, unknown>
      seam['listChildren'] = listChildren
      const result = await call(ctx, { description: 'x', prompt: 't', run_in_background: true }, agentAt('/any'))
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toContain(
        'parent has 25 live subagents; /agents stop <id> to release one, or let children settle',
      )
      expect(listChildren).toHaveBeenCalled()
    })

    it('refuses a foreground collect start at the same limit', async () => {
      const { ctx } = await mount()
      const rows = Array.from({ length: 25 }, () => childRow('running'))
      const seam = ctx.get('subagents') as Record<string, unknown>
      seam['listChildren'] = vi.fn(async () => rows)
      const result = await call(ctx, { description: 'x', prompt: 't' }, agentAt('/any'))
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toContain('parent has 25 live subagents')
    })

    it('does not count inactive or non-child rows and admits at 24', async () => {
      const { ctx, continuableStarts } = await mount()
      const rows = [
        ...Array.from({ length: 24 }, () => childRow('running')),
        childRow('inactive'),
        { kind: 'diagnostic', id: 'x' },
      ]
      const seam = ctx.get('subagents') as Record<string, unknown>
      seam['listChildren'] = vi.fn(async () => rows)
      const result = await call(ctx, { description: 'x', prompt: 't', run_in_background: true }, agentAt('/any'))
      expect(result.isError).toBe(false)
      expect(continuableStarts).toHaveLength(1)
    })

    it('degrades open when the seam lacks listChildren', async () => {
      const { ctx, continuableStarts } = await mount()
      const result = await call(ctx, { description: 'x', prompt: 't', run_in_background: true }, agentAt('/any'))
      expect(result.isError).toBe(false)
        expect(continuableStarts).toHaveLength(1)
    })
  })

  describe('Ctrl+B promotion of a foreground collect (Slice 3)', () => {
    function agentWithId(cwd: string, id: string): Agent {
      return { id, session: { header: { cwd } } } as unknown as Agent
    }

    it('promote-wins: the pending collect resolves async_launched + backgroundedByUser and the later notice is not suppressed', async () => {
      const { ctx, startedChildIds, emitEnd } = await mount({ seamProviders: [pendingProvider()] })
      const pending = call(ctx, { description: 'x', prompt: 't' }, agentWithId('/any', 'parent-t'))
      await new Promise(resolve => setTimeout(resolve, 10))
      const armed = collectorsForSession('parent-t')
      expect(armed).toHaveLength(1)
      armed[0]!.promote()
      const result = await pending
      expect(result.isError).toBe(false)
      expect(result.content[0]!.text).toContain(`agentId: ${startedChildIds[0]}`)
      expect(result.content[0]!.text).toContain('backgroundedByUser')
      expect(result.content[0]!.text).toMatch(/later waking message/)
      // The promoted child is un-suppressed: its real terminal arrives as the
      // settlement notice (drop is NOT armed anymore).
      emitEnd(startedChildIds[0]!, COMPLETED)
      expect(collectorsForSession('parent-t')).toEqual([])
    })

    it('settle-wins: the collect resolves completed inline and the registry entry is removed', async () => {
      const { ctx } = await mount()
      const result = await call(ctx, { description: 'x', prompt: 't' }, agentWithId('/any', 'parent-s'))
      expect(result.isError).toBe(false)
      expect(result.content[0]!.text).toBe('done')
      expect(collectorsForSession('parent-s')).toEqual([])
    })

    it('teaches the promotion clause in the tool description and the background section', () => {
      expect(BACKGROUND_SECTION_TEXT).toMatch(/backgroundedByUser: true/)
      expect(BACKGROUND_SECTION_TEXT).toMatch(/later wake/)
    })
  })
})
