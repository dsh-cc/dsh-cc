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
import { backgroundTasksDisabled, EPHEMERAL_BACKGROUND_REJECT, EPHEMERAL_PIN_IGNORED_NOTICE, EPHEMERAL_PROMOTION_NOTICE, EPHEMERAL_WORKTREE_REJECT, registerTaskTool, TASK_TOOL } from '../src/tool.ts'
import { LIVE_CAPACITY_REFUSAL } from '../src/background-start.ts'
import { RELEASE_AGENT_TOOL, registerReleaseAgentTool } from '../src/release-agent.ts'
import { markReleasing, resetReleasedMarkers } from '@dsh-cc/command-agents/release'
import { PinStore } from '@dsh-cc/subagent-resume-pins'
import { SpawnPinCapture } from '../src/resume-capture.ts'
import { EPHEMERAL_TTL_KILL_COPY } from '../src/ephemeral-reaper.ts'
import { BACKGROUND_SECTION_TEXT } from '../src/index.ts'
import { collectorsForSession } from '../src/epoch-collector.ts'
import { PLUGIN_AGENT_PROVIDER_BRAND } from '@dsh-cc/plugin-loader'
import { sanitizeToolFilter } from '../src/sanitize-filter.ts'

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
  /** The durable child ids handed out by startActivation, in order. */
  startedChildIds: string[]
  /** Children whose activation was disposed (one-shot dispose policy). */
  disposedChildIds: string[]
  emitEnd: (childId: string, epoch: EpochShape) => void
} {
  const runs: StartedRun[] = []
  const continuableStarts: RecordedContinuable[] = []
  const startedChildIds: string[] = []
  const disposedChildIds: string[] = []
  const runIdByChild = new Map<string, string>()
  const byName = new Map(providers.map(p => [p.name, p]))
  const seam: Record<string, unknown> = {
    // rc.5 unified entry. Mirrors the manager's routing: a provider without
    // prepareContinuable is external (a reserved childId rejects); a local
    // child publishes subagent/start and settles into subagent/end; dispose
    // settles a pending epoch with stopReason 'aborted'.
    async startActivation(spec: Record<string, unknown>): Promise<{
      childId: string
      messageId?: string
      result: Promise<EpochShape>
      dispose(): Promise<void>
    }> {
      const providerName = spec['provider'] as string
      const provider = byName.get(providerName)
      if (provider === undefined) throw new Error(`unknown provider "${providerName}"`)
      const request = (spec['request'] ?? {}) as Record<string, unknown>
      const caps = provider.capabilities as unknown as Record<string, boolean>
      if (request['maxDepth'] !== undefined && caps['depthLimit'] === false) throw new Error('UNSUPPORTED_CAPABILITY maxDepth')
      if (request['outputSchema'] !== undefined && caps['outputSchema'] === false) throw new Error('UNSUPPORTED_CAPABILITY outputSchema')
      const local = provider.prepareContinuable !== undefined
      const reserved = spec['childId'] as string | undefined
      if (!local && reserved !== undefined) {
        const error = new Error('reserved child ids require a local backend') as Error & { code?: string }
        error.code = 'UNSUPPORTED_CAPABILITY'
        throw error
      }
      if (!local && spec['delivery'] === 'parent') {
        const error = new Error(
          `subagent provider "${providerName}" does not support continuable children (no prepareContinuable capability)`,
        ) as Error & { code?: string }
        error.code = 'UNSUPPORTED_CAPABILITY'
        throw error
      }
      const childId = reserved ?? `child-${startedChildIds.length + 1}`
      const runId = `run-${startedChildIds.length + 1}`
      const killed = Promise.withResolvers<EpochShape>()
      if (spec['delivery'] === 'parent') {
        continuableStarts.push({ provider: providerName, label: spec['label'] as string, request })
      } else {
        runs.push({ provider: providerName, request })
      }
      startedChildIds.push(childId)
      runIdByChild.set(childId, runId)
      if (local) {
        // Mirror the harness: `subagent/start` fires at publication, and the
        // epoch settles asynchronously into `subagent/end`.
        emit?.('subagent/start', { runId, provider: providerName, id: childId, local: true })
      }
      const result = Promise.resolve()
        .then(() => provider.start(request))
        .then(run => Promise.race([run.result, killed.promise]))
      void result.then((settled) => {
        if (!local) return
        emit?.('subagent/end', {
          runId,
          provider: providerName,
          id: childId,
          local: true,
          stopReason: settled.stopReason,
          ...(settled.output !== undefined ? { lastAssistantMessage: settled.output } : {}),
        })
      }, () => {})
      return {
        childId,
        messageId: 'm-1',
        result,
        async dispose() {
          // Idempotent, mirroring the manager: the one-shot lanes may hit
          // dispose twice (the post-publication abort hook and the settle
          // finally), and only the first releases the slot.
          if (disposedChildIds.includes(childId)) return
          disposedChildIds.push(childId)
          killed.resolve({ stopReason: 'aborted' })
        },
      }
    },
    getProvider(name: string) { return byName.get(name) },
    list() { return [...byName.keys()] },
  }
  return {
    seam,
    runs,
    continuableStarts,
    startedChildIds,
    disposedChildIds,
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
  omitStartActivation?: boolean
  withCapture?: boolean
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const emit = (event: string, info: Record<string, unknown>): void => {
    ;(ctx as unknown as { emit(event: string, info: unknown): void }).emit(event, info)
  }
  const { seam, runs, continuableStarts, startedChildIds, disposedChildIds, emitEnd } = makeSeam(opts.seamProviders ?? defaultProviders(), emit)
  if (opts.omitStartActivation === true) delete (seam as Record<string, unknown>)['startActivation']
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
  return { ctx, runs, continuableStarts, startedChildIds, disposedChildIds, emitEnd, registry, store }
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
/**
 * The live known-name set exactly as the tool reads it at dispatch (the
 * calling agent passed so standing-scope MCP names are visible). rc.5 keeps
 * the sanitize rules observable through preload; the filter itself no longer
 * rides the start request (the composition slice applies it), so the rule
 * assertions below pin `sanitizeToolFilter` against this set directly.
 */
function knownNames(ctx: Context, agent: Agent): Set<string> {
  const tools = ctx.tools as unknown as { view?: (a?: Agent) => { restrictableNames?: Set<string> } }
  return tools.view?.(agent).restrictableNames ?? new Set<string>()
}

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
    expect(result.content[0]!.text).toMatch(/^done \(auto-released after 30 minutes of inactivity, expires \d{2}:\d{2}\)$/)
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
    expect(result.content[0]!.text).toMatch(/^done \(auto-released after 30 minutes of inactivity, expires \d{2}:\d{2}\)$/)
    expect(runs).toHaveLength(0)
    expect(continuableStarts[0]!.provider).toBe('spawn')
    const req = continuableStarts[0]!.request
    // rc.5: persona no longer rides the start request (composition slice).
    expect(req['persona']).toBeUndefined()
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
    expect(result.content[0]!.text).toMatch(/^done \(auto-released after 30 minutes of inactivity, expires \d{2}:\d{2}\)$/)
    expect(runs).toHaveLength(0)
    expect(continuableStarts[0]!.request['persona']).toBeUndefined()
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
    const { ctx, runs, continuableStarts, registry } = await mount({ routes })
    reserveNames(ctx, 'read', 'read_image', 'glob', 'grep')
    const agent = agentAt(ws)
    const result = await call(ctx, { subagent_type: 'explore', description: 'find it', prompt: 'where is X defined?' }, agent)
    expect(result.content[0]!.text).toContain('done')
    // §3.2: the whitelisted read-only definition dispatches one-shot through startActivation (delivery 'caller').
    expect(runs).toHaveLength(1)
    expect(runs[0]!.provider).toBe('spawn')
    expect(continuableStarts).toHaveLength(0)
    expect(runs[0]!.request['agentOptions']).toEqual({ provider: 'p', model: 'cheap' })
    // rc.5: persona/toolFilter no longer ride the start request (composition slice);
    // the bundled explore restriction still survives sanitization unchanged.
    expect(runs[0]!.request['persona']).toBeUndefined()
    expect(runs[0]!.request['toolFilter']).toBeUndefined()
    const def = (await registry.resolve(ws, 'explore'))!
    const filter = sanitizeToolFilter(def.toolRestriction!, () => {}, knownNames(ctx, agent))
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
    expect(continuableStarts).toHaveLength(0)
    expect(runs[0]!.request['agentOptions']).toBeUndefined()
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
    expect(result.content[0]!.text).toMatch(/^answer A answer B \(auto-released after 30 minutes of inactivity, expires \d{2}:\d{2}\)$/)
  })

  it('keeps reserved and registered names in a definition toolFilter', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'guarded', '---\nname: guarded\ndescription: With tools\ntools: [Read, Task, Bash]\n---\nGuarded.\n')
    // `Task` translates to ['subagent', 'subagent_fork']; `subagent` is
    // reserved by registerTaskTool and `subagent_fork` is the registered Task
    // tool. `read`/`read_image`/`bash` must be mounted (registered or
    // reserved) or sanitization drops them — here they are reserved, as the
    // cc preset registers them.
    const { ctx, runs, continuableStarts, registry } = await mount()
    reserveNames(ctx, 'read', 'read_image', 'bash')
    const agent = agentAt(ws)
    await call(ctx, { subagent_type: 'guarded', description: 'x', prompt: 't' }, agent)
    expect(runs).toHaveLength(0)
    expect(continuableStarts).toHaveLength(1)
    // rc.5: the request never carries the filter; the composition slice applies it.
    expect(continuableStarts[0]!.request['toolFilter']).toBeUndefined()
    const def = (await registry.resolve(ws, 'guarded'))!
    const filter = sanitizeToolFilter(def.toolRestriction!, () => {}, knownNames(ctx, agent))
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
    const { ctx, runs, continuableStarts, registry } = await mount()
    reserveNames(ctx, 'read', 'read_image')
    const agent = agentAt(ws)
    await call(ctx, { subagent_type: 'typoed', description: 'x', prompt: 't' }, agent)
    expect(continuableStarts[0]!.request['toolFilter']).toBeUndefined()
    const def = (await registry.resolve(ws, 'typoed'))!
    const filter = sanitizeToolFilter(def.toolRestriction!, () => {}, knownNames(ctx, agent))
    expect(filter?.allow).toEqual(['read', 'read_image'])
  })

  it('keeps an exact mounted MCP public name and auto-includes mounted ToolSearch', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'mcp-user', '---\nname: mcp-user\ndescription: MCP\ntools: [Read, mcp__github__create_issue]\n---\nMCP.\n')
    const { ctx, runs, continuableStarts, registry } = await mount()
    reserveNames(ctx, 'mcp__github__create_issue', 'mcp__github__search', 'read', 'read_image', 'ToolSearch')
    const warn = captureWarn(ctx)
    const agent = agentAt(ws)
    await call(ctx, { subagent_type: 'mcp-user', description: 'x', prompt: 't' }, agent)
    expect(continuableStarts[0]!.request['toolFilter']).toBeUndefined()
    const def = (await registry.resolve(ws, 'mcp-user'))!
    const filter = sanitizeToolFilter(def.toolRestriction!, () => {}, knownNames(ctx, agent))
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
    const { ctx, runs, continuableStarts, registry } = await mount()
    reserveNames(ctx, 'mcp__github__create_issue', 'mcp__github__search', 'ToolSearch')
    const agent = agentAt(ws)
    await call(ctx, { subagent_type: 'wild-a', description: 'x', prompt: 't' }, agent)
    await call(ctx, { subagent_type: 'wild-b', description: 'x', prompt: 't' }, agent)
    expect(continuableStarts).toHaveLength(2)
    for (const start of continuableStarts) expect(start.request['toolFilter']).toBeUndefined()
    for (const type of ['wild-a', 'wild-b']) {
      const def = (await registry.resolve(ws, type))!
      const filter = sanitizeToolFilter(def.toolRestriction!, () => {}, knownNames(ctx, agent))
      expect(filter?.allow).toContain('mcp__github__create_issue')
      expect(filter?.allow).toContain('mcp__github__search')
      expect(filter?.allow).toContain('ToolSearch')
      await assertRestrictable(ctx, filter as ToolRestriction)
    }
  })

  it('sees MCP names reserved on an ancestor standing-scope layer', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'mcp-user', '---\nname: mcp-user\ndescription: MCP\ntools: [mcp__github__create_issue]\n---\nMCP.\n')
    const { ctx, runs, continuableStarts, registry } = await mount()
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
    expect(continuableStarts[0]!.request['toolFilter']).toBeUndefined()
    const def = (await registry.resolve(ws, 'mcp-user'))!
    const filter = sanitizeToolFilter(def.toolRestriction!, () => {}, knownNames(ctx, caller))
    expect(filter?.allow).toContain('mcp__github__create_issue')
    expect(filter?.allow).toContain('ToolSearch')
    await child.dispose()
    await standing.dispose()
  })

  it('never auto-includes ToolSearch when it is not mounted', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'mcp-user', '---\nname: mcp-user\ndescription: MCP\ntools: [mcp__github__create_issue]\n---\nMCP.\n')
    const { ctx, runs, continuableStarts, registry } = await mount()
    reserveNames(ctx, 'mcp__github__create_issue')
    const agent = agentAt(ws)
    await call(ctx, { subagent_type: 'mcp-user', description: 'x', prompt: 't' }, agent)
    expect(continuableStarts[0]!.request['toolFilter']).toBeUndefined()
    const def = (await registry.resolve(ws, 'mcp-user'))!
    const filter = sanitizeToolFilter(def.toolRestriction!, () => {}, knownNames(ctx, agent))
    expect(filter?.allow).toContain('mcp__github__create_issue')
    expect(filter?.allow).not.toContain('ToolSearch')
    await assertRestrictable(ctx, filter!)
  })

  it('emits a deny-all allow list (with a warning) when the allow-list matches no mounted tools', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'missing', '---\nname: missing\ndescription: M\ntools: [mcp__missing__foo]\n---\nM.\n')
    const { ctx, runs, continuableStarts, registry } = await mount()
    const warn = captureWarn(ctx)
    const agent = agentAt(ws)
    await call(ctx, { subagent_type: 'missing', description: 'x', prompt: 't' }, agent)
    expect(continuableStarts[0]!.request['toolFilter']).toBeUndefined()
    const def = (await registry.resolve(ws, 'missing'))!
    const filter = sanitizeToolFilter(def.toolRestriction!, m => warn(m), knownNames(ctx, agent))
    expect(filter).toEqual({ allow: [] })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mcp__missing__foo'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no mounted tools'))
    await assertRestrictable(ctx, filter!)
  })

  it('keeps a mounted MCP name in a disallowedTools deny-list', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'mcp-denied', '---\nname: mcp-denied\ndescription: D\ndisallowedTools: [mcp__github__search]\n---\nD.\n')
    const { ctx, runs, continuableStarts, registry } = await mount()
    reserveNames(ctx, 'mcp__github__search')
    const agent = agentAt(ws)
    await call(ctx, { subagent_type: 'mcp-denied', description: 'x', prompt: 't' }, agent)
    expect(continuableStarts[0]!.request['toolFilter']).toBeUndefined()
    const def = (await registry.resolve(ws, 'mcp-denied'))!
    const filter = sanitizeToolFilter(def.toolRestriction!, () => {}, knownNames(ctx, agent))
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
    const { ctx, runs, continuableStarts, registry } = await mount()
    const warn = captureWarn(ctx)
    const agent = agentAt(ws)
    await call(ctx, { subagent_type: 'bare', description: 'x', prompt: 't' }, agent)
    expect(continuableStarts[0]!.request['toolFilter']).toBeUndefined()
    const def = (await registry.resolve(ws, 'bare'))!
    const filter = sanitizeToolFilter(def.toolRestriction!, m => warn(m), knownNames(ctx, agent))
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
      // rc.5: the dispatch reserves the child id before publication so the
      // composition plan can be keyed; assert the notice names THAT id.
      expect(result.content[0]!.text).toMatch(/agentId: [0-9a-f-]{36}/)
      expect(result.content[0]!.text).toContain('list_agents')
      expect(result.content[0]!.text).toContain('send_message')
      expect(result.content[0]!.text).toContain('interrupt_agent')
      expect(JSON.stringify(result)).not.toContain('outputFile')
    })

    it('folds a named definition exactly like the foreground path into the continuable request', async () => {
      const ws = freshWorkspace()
      writeAgent(ws, 'deep-reasoner', '---\nname: deep-reasoner\ndescription: Review heavy work\nmodel: opus\ntools: [Read, Bash]\n---\nYou are a Staff Engineer.\n')
      const routes = { resolve: (m: string | undefined) => m === 'opus' ? { provider: 'orchestrix', model: 'glm-5.2' } : undefined }
      const { ctx, runs, continuableStarts, registry } = await mount({ routes })
      reserveNames(ctx, 'read', 'bash')
      const agent = agentAt(ws)
      await call(ctx, {
        subagent_type: 'deep-reasoner',
        description: 'review',
        prompt: 'audit the doc',
        run_in_background: true,
      }, agent)
      expect(runs).toHaveLength(0)
      expect(continuableStarts[0]!.provider).toBe('spawn')
      const req = continuableStarts[0]!.request
      // rc.5: persona/toolFilter no longer ride the start request (composition slice).
      expect(req['persona']).toBeUndefined()
      expect(req['toolFilter']).toBeUndefined()
      expect(req['prompt']).toEqual([{ type: 'text', text: 'audit the doc' }])
      expect(req['agentOptions']).toEqual({ provider: 'orchestrix', model: 'glm-5.2' })
      expect(req['maxDepth']).toBe(3)
      const def = (await registry.resolve(ws, 'deep-reasoner'))!
      const filter = sanitizeToolFilter(def.toolRestriction!, () => {}, knownNames(ctx, agent))
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

    it('maps a seam without startActivation to an actionable capability error', async () => {
      const { ctx, runs } = await mount({ omitStartActivation: true })
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
      expect(omitted.content[0]!.text).toMatch(/^done \(auto-released after 30 minutes of inactivity, expires \d{2}:\d{2}\)$/)
      expect(explicitFalse.content[0]!.text).toMatch(/^done \(auto-released after 30 minutes of inactivity, expires \d{2}:\d{2}\)$/)
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(2)
      expect(continuableStarts.every(s => s.provider === 'spawn')).toBe(true)
    })

    it('renders the background contract text naming the durable id and the control loop', async () => {
      const { ctx } = await mount()
      const result = await call(ctx, { description: 'x', prompt: 't', run_in_background: true }, agentAt('/any'))
      const text = result.content[0]!.text
      expect(text).toMatch(/agentId: [0-9a-f-]{36}/)
      expect(text).toMatch(/wak(e|ing)|finish/)
      expect(text).toMatch(/list_agents/)
      expect(text).toMatch(/send_message/)
      expect(text).toMatch(/same assignment/)
      expect(text).toMatch(/interrupt_agent/)
      expect(text.toLowerCase()).not.toContain('outputfile')
    })

    it('rejects the bundled explore agent with explicit run_in_background: true (ephemeral fail-fast)', async () => {
      const ws = freshWorkspace()
      const { ctx, runs, continuableStarts } = await mount()
      reserveNames(ctx, 'read', 'read_image', 'glob', 'grep')
      const result = await call(ctx, {
        subagent_type: 'explore',
        description: 'find it',
        prompt: 'where is X?',
        run_in_background: true,
      }, agentAt(ws))
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toBe(`Error: ${EPHEMERAL_BACKGROUND_REJECT}`)
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(0)
    })
  })

  describe('definition.background pin', () => {
    it('backgrounds on omit when the definition pins background: true (persona travels via composition)', async () => {
      const ws = freshWorkspace()
      writeAgent(ws, 'scout', '---\nname: scout\ndescription: Pinned to background\nbackground: true\n---\nYou are a pinned scout.\n')
      const { ctx, runs, continuableStarts } = await mount()
      await call(ctx, { subagent_type: 'scout', description: 'pinned', prompt: 'grind' }, agentAt(ws))
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(1)
      expect(continuableStarts[0]!.provider).toBe('spawn')
      // rc.5: persona no longer rides the start request (composition slice).
      expect(continuableStarts[0]!.request['persona']).toBeUndefined()
      expect(continuableStarts[0]!.request['prompt']).toEqual([{ type: 'text', text: 'grind' }])
    })

    it('explicit run_in_background: false wins over the pin and keeps the foreground path', async () => {
      const ws = freshWorkspace()
      writeAgent(ws, 'scout', '---\nname: scout\ndescription: Pinned to background\nbackground: true\n---\nYou are a pinned scout.\n')
      const { ctx, runs, continuableStarts } = await mount()
      const result = await call(ctx, { subagent_type: 'scout', description: 'pinned', prompt: 't', run_in_background: false }, agentAt(ws))
      expect(result.content[0]!.text).toMatch(/^done \(auto-released after 30 minutes of inactivity, expires \d{2}:\d{2}\)$/)
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(1)
      expect(continuableStarts[0]!.provider).toBe('spawn')
      expect(continuableStarts[0]!.request['persona']).toBeUndefined()
    })

    it('explicit run_in_background: true also backgrounds a pinned definition', async () => {
      const ws = freshWorkspace()
      writeAgent(ws, 'scout', '---\nname: scout\ndescription: Pinned to background\nbackground: true\n---\nYou are a pinned scout.\n')
      const { ctx, runs, continuableStarts } = await mount()
      await call(ctx, { subagent_type: 'scout', description: 'pinned', prompt: 't', run_in_background: true }, agentAt(ws))
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(1)
      expect(continuableStarts[0]!.request['persona']).toBeUndefined()
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

    it('the bundled explore agent runs one-shot in the foreground on omit (ephemeral wins, no pin)', async () => {
      const ws = freshWorkspace()
      const { ctx, runs, continuableStarts } = await mount()
      const result = await call(ctx, { subagent_type: 'explore', description: 'find it', prompt: 'where is X?' }, agentAt(ws))
      expect(result.content[0]!.text).toContain('done')
      expect(continuableStarts).toHaveLength(0)
      expect(runs).toHaveLength(1)
      expect(runs[0]!.provider).toBe('spawn')
      expect(runs[0]!.request['persona']).toBeUndefined()
      expect(result.content[0]!.text).toContain(EPHEMERAL_PROMOTION_NOTICE)
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

    it('teaches the one-task-one-instance delegation contract in the background section', () => {
      expect(BACKGROUND_SECTION_TEXT).toMatch(/one task, one instance/i)
      expect(BACKGROUND_SECTION_TEXT).toMatch(/current assignment/)
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

    it('teaches the one-task-one-instance delegation contract in the tool description', async () => {
      const { ctx } = await mount()
      const def = ctx.tools.get(TASK_TOOL) as unknown as { description: string } | undefined
      expect(def).toBeDefined()
      expect(def!.description).toMatch(/One task, one instance/)
      expect(def!.description).toMatch(/steer it in flight/)
      expect(def!.description).toMatch(/current assignment/i)
    })
  })

  describe('foreground collect through the epoch collector', () => {
    it('collects the first epoch inline from the continuable child (no one-shot start)', async () => {
      const { ctx, runs, continuableStarts } = await mount()
      const result = await call(ctx, { description: 'x', prompt: 't' }, agentAt('/any'))
      expect(result.content[0]!.text).toMatch(/^done \(auto-released after 30 minutes of inactivity, expires \d{2}:\d{2}\)$/)
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
        expect(omitted.content[0]!.text).toMatch(/^done \(auto-released after 30 minutes of inactivity, expires \d{2}:\d{2}\)$/)
        expect(runs).toHaveLength(0)
        expect(continuableStarts).toHaveLength(1)
        // Explicit true still honored both ways.
        const explicit = await call(ctx, { subagent_type: 'scout', description: 'x', prompt: 't', run_in_background: true }, agentAt(ws))
        expect(explicit.content[0]!.text).toContain('Background subagent started')
        expect(continuableStarts).toHaveLength(2)
        // Explicit false still foreground.
        const forced = await call(ctx, { subagent_type: 'scout', description: 'x', prompt: 't', run_in_background: false }, agentAt(ws))
        expect(forced.content[0]!.text).toMatch(/^done \(auto-released after 30 minutes of inactivity, expires \d{2}:\d{2}\)$/)
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

    it('folds agentOptions/maxDepth into the recorded spawn start request (persona/toolFilter travel via composition)', async () => {
      const routes = { resolve: (m: string | undefined) => m === 'opus' ? { provider: 'orchestrix', model: 'glm-5.2' } : undefined }
      const { ctx, runs, continuableStarts } = await mountWithPlugin({
        routes,
        withCapture: false,
        pluginDefs: [{ systemPrompt: 'You are the plugin researcher.', toolRestriction: { allow: ['read', 'write'] }, model: 'opus' }],
      })
      reserveNames(ctx, 'read')
      const agent = agentAt('/any')
      const result = await call(ctx, {
        subagent_type: 'p:researcher',
        description: 'review',
        prompt: 'audit the doc',
        run_in_background: true,
      }, agent)
      expect(result.isError).toBe(false)
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(1)
      expect(continuableStarts[0]!.provider).toBe('spawn')
      const req = continuableStarts[0]!.request
      // rc.5: persona/toolFilter no longer ride the start request (composition slice).
      expect(req['persona']).toBeUndefined()
      expect(req['toolFilter']).toBeUndefined()
      expect(req['prompt']).toEqual([{ type: 'text', text: 'audit the doc' }])
      expect(req['agentOptions']).toEqual({ provider: 'orchestrix', model: 'glm-5.2' })
      expect(req['maxDepth']).toBe(3)
      // The plugin definition's restriction survives sanitization against the
      // live known set (same seam the composition plan consumes).
      const filter = sanitizeToolFilter({ allow: ['read', 'write'] }, () => {}, knownNames(ctx, agent))
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
      expect(continuableStarts[0]!.request['persona']).toBeUndefined()
    })

    it('returns the collected text for a foreground plugin dispatch', async () => {
      const { ctx, runs, continuableStarts } = await mountWithPlugin({
        pluginDefs: [{ systemPrompt: 'Foreground plugin.' }],
      })
      const result = await call(ctx, { subagent_type: 'p:researcher', description: 'x', prompt: 't' }, agentAt('/any'))
      expect(result.content[0]!.text).toMatch(/^done \(auto-released after 30 minutes of inactivity, expires \d{2}:\d{2}\)$/)
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(1)
      expect(continuableStarts[0]!.provider).toBe('spawn')
      expect(continuableStarts[0]!.request['persona']).toBeUndefined()
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
      expect(continuableStarts[0]!.request['persona']).toBeUndefined()
      expect(continuableStarts[1]!.request['persona']).toBeUndefined()
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

  describe('ephemeral dispatch (§3.2 one-shot lane)', () => {
    it('dispatches a writer (shunt-writer shape) through collectForeground — the continuable path', async () => {
      const ws = freshWorkspace()
      writeAgent(ws, 'shunt-writer', '---\nname: shunt-writer\ndescription: Writes\n---\nWrite body.\n')
      const { ctx, runs, continuableStarts } = await mount()
      const result = await call(ctx, { subagent_type: 'shunt-writer', description: 'x', prompt: 't' }, agentAt(ws))
      expect(result.content[0]!.text).toMatch(/^done \(auto-released after 30 minutes of inactivity, expires \d{2}:\d{2}\)$/)
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(1)
      expect(continuableStarts[0]!.provider).toBe('spawn')
    })

    it('dispatches a critic-shaped agent (no tools key, background pin) through startBackground on omit', async () => {
      const ws = freshWorkspace()
      writeAgent(ws, 'critic', '---\nname: critic\ndescription: Reviews\nbackground: true\n---\nCritic body.\n')
      const { ctx, runs, continuableStarts } = await mount()
      await call(ctx, { subagent_type: 'critic', description: 'x', prompt: 't' }, agentAt(ws))
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(1)
      expect(continuableStarts[0]!.provider).toBe('spawn')
    })

    it('background: true pin + ephemeral + omit → foreground one-shot with the pin-ignored notice', async () => {
      const ws = freshWorkspace()
      writeAgent(ws, 'pinned-scout', '---\nname: pinned-scout\ndescription: S\nbackground: true\ntools:\n  - Read\n  - Glob\n---\nScout body.\n')
      const { ctx, runs, continuableStarts } = await mount()
      reserveNames(ctx, 'read', 'read_image', 'glob', 'grep')
      const result = await call(ctx, { subagent_type: 'pinned-scout', description: 'x', prompt: 't' }, agentAt(ws))
      expect(continuableStarts).toHaveLength(0)
      expect(runs).toHaveLength(1)
      expect(runs[0]!.provider).toBe('spawn')
      expect(result.content[0]!.text).toBe(`done\n${EPHEMERAL_PROMOTION_NOTICE} ${EPHEMERAL_PIN_IGNORED_NOTICE}`)
    })

    it('carries no filter on the ephemeral branch (rc.5: the post-sanitize ToolSearch strip moved to the composition slice)', async () => {
      const ws = freshWorkspace()
      writeAgent(ws, 'scout', '---\nname: scout\ndescription: S\ntools:\n  - Read\n  - mcp__serena__find_symbol\n---\nScout body.\n')
      const { ctx, runs, registry } = await mount()
      reserveNames(ctx, 'read', 'read_image', 'mcp__serena__find_symbol', 'ToolSearch')
      const agent = agentAt(ws)
      await call(ctx, { subagent_type: 'scout', description: 'x', prompt: 't' }, agent)
      // rc.5: the start request never carries a filter, so there is nothing
      // branch-local to strip; the ephemeral dispatch-kind strip of ToolSearch
      // is reapplied inside the composition plan by its own slice.
      expect(runs[0]!.request['toolFilter']).toBeUndefined()
      const def = (await registry.resolve(ws, 'scout'))!
      const filter = sanitizeToolFilter(def.toolRestriction!, () => {}, knownNames(ctx, agent))
      expect(filter.allow).toContain('read')
      expect(filter.allow).toContain('mcp__serena__find_symbol')
      await assertRestrictable(ctx, filter as ToolRestriction)
    })

    it('isolation: worktree + ephemeral → fail-fast refusal naming a continuable lane', async () => {
      const ws = freshWorkspace()
      writeAgent(ws, 'wts', '---\nname: wts\ndescription: S\ntools:\n  - Read\nisolation: worktree\n---\nBody.\n')
      const { ctx, runs, continuableStarts } = await mount()
      reserveNames(ctx, 'read', 'read_image', 'glob', 'grep')
      const result = await call(ctx, { subagent_type: 'wts', description: 'x', prompt: 't' }, agentAt(ws))
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toBe(`Error: ${EPHEMERAL_WORKTREE_REJECT}`)
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(0)
    })

    it('§3.4 foreground TTL kill surfaces the pinned remedy copy', async () => {
      const ws = freshWorkspace()
      writeAgent(ws, 'scout', '---\nname: scout\ndescription: S\nephemeral: true\nephemeralTtlMs: 20\ntools:\n  - Read\n---\nBody.\n')
      // rc.5: a TTL kill reaches the running child through dispose() (the
      // activation signal covers pre-publication only). The fake settles a
      // pending run with stopReason 'aborted' when its activation is disposed.
      const provider: FakeProvider = {
        name: 'spawn',
        capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
        start: async () => ({ result: new Promise<{ stopReason: string }>(() => {}) }),
      }
      const { ctx, disposedChildIds } = await mount({ seamProviders: [provider, capableProvider('fork', COMPLETED)] })
      reserveNames(ctx, 'read')
      const result = await call(ctx, { subagent_type: 'scout', description: 'x', prompt: 't' }, agentAt(ws))
      expect(disposedChildIds).toHaveLength(1)
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toBe(`Error: ${EPHEMERAL_TTL_KILL_COPY}`)
    })

    it('§3.4 parallel-safety pin: one run\'s TTL kill must not disturb the sibling run', async () => {
      const ws = freshWorkspace()
      writeAgent(ws, 'scout', '---\nname: scout\ndescription: S\nephemeral: true\nephemeralTtlMs: 20\n---\nBody.\n')
      // The sibling gets a far-future TTL: only the FIRST run's timer fires.
      writeAgent(ws, 'scout-slow', '---\nname: scout-slow\ndescription: S\nephemeral: true\nephemeralTtlMs: 600000\n---\nBody.\n')
      // rc.5: a TTL kill reaches only ITS run through dispose() (kill identity
      // is the per-run controller); the sibling's activation stays live.
      const started: number[] = []
      const provider: FakeProvider = {
        name: 'spawn',
        capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
        start: async () => {
          started.push(started.length)
          return { result: new Promise<{ stopReason: string }>(resolve => { released.push(resolve) }) }
        },
      }
      const released: ((value: { stopReason: string; output?: readonly { type: string; text?: string }[] }) => void)[] = []
      const { ctx, disposedChildIds } = await mount({ seamProviders: [provider, capableProvider('fork', COMPLETED)] })
      const first = call(ctx, { subagent_type: 'scout', description: 'x', prompt: 't' }, agentAt(ws))
      // Let the first dispatch reach its activation, then wait for ITS TTL to
      // dispose exactly that activation.
      await vi.waitFor(() => expect(started).toHaveLength(1))
      await vi.waitFor(() => expect(disposedChildIds).toHaveLength(1))
      const resultFirst = await first
      expect(resultFirst.isError).toBe(true)
      expect(resultFirst.content[0]!.text).toBe(`Error: ${EPHEMERAL_TTL_KILL_COPY}`)
      // The sibling dispatches AFTER the first kill, settles completed, and
      // its activation is never disposed by the sibling timer before release.
      const second = call(ctx, { subagent_type: 'scout-slow', description: 'y', prompt: 't' }, agentAt(ws))
      await vi.waitFor(() => expect(started).toHaveLength(2))
      expect(disposedChildIds).toHaveLength(1)
      released[1]!({ stopReason: 'completed', output: [{ type: 'text', text: 'sibling done' }] })
      const result = await second
      expect(result.isError).toBe(false)
      expect(result.content[0]!.text).toContain('sibling done')
    })

    it('R6: an interrupt AFTER start names send_message + id as the resume path', async () => {
      const seamProviders = defaultProviders({ stopReason: 'aborted' })
      const { ctx } = await mount({ seamProviders })
      const result = await call(ctx, { description: 'x', prompt: 't' }, agentAt('/any'))
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toMatch(/session persisted; send_message to /)
    })

    it('R6: a start failure (seam without startActivation) keeps plain error copy and claims no resumability', async () => {
      const { ctx } = await mount({ omitStartActivation: true })
      const result = await call(ctx, { description: 'x', prompt: 't' }, agentAt('/any'))
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toMatch(/background subagents are unavailable/)
      expect(result.content[0]!.text).not.toMatch(/session persisted/)
    })
  })

  describe('capacity (harness resident pool; rc.5)', () => {
    /** A pool throw shaped like the harness SubagentError (code carried off-message). */
    function poolFullError(): Error & { code: string } {
      return Object.assign(
        new Error('subagent limit reached (active child limit: 25); wait for an existing child to finish or complete this work with the current agents'),
        { code: 'ACTIVATION_LIMIT_REACHED' },
      )
    }

    /** Mount, then wrap the seam's startActivation to throw the pool refusal while `full` stays truthy. */
    async function mountWithPool(full: { readonly value: boolean }) {
      const mounted = await mount()
      const seam = mounted.ctx.get('subagents') as Record<string, unknown>
      const real = seam['startActivation'] as (spec: unknown) => Promise<unknown>
      seam['startActivation'] = (spec: unknown) => {
        if (full.value) return Promise.reject(poolFullError())
        return real(spec)
      }
      return mounted
    }

    /** An agent fixture whose ctx resolves the mounted services (unused registry lookups degrade open). */
    function agentWithCtx(ctx: Context, cwd = '/any'): Agent {
      return { ctx, session: { header: { cwd } } } as unknown as Agent
    }

    it('refuses a background start with the D4 resident-cap copy when the pool is full', async () => {
      const { ctx } = await mountWithPool({ value: true })
      const result = await call(ctx, { description: 'x', prompt: 't', run_in_background: true }, agentWithCtx(ctx))
      expect(result.isError).toBe(true)
      // The tool runtime prefixes tool errors with "Error: "; the copy after
      // the prefix is the exact D4 literal (full equality).
      expect(result.content[0]!.text).toBe(`Error: ${LIVE_CAPACITY_REFUSAL}`)
    })

    it('refuses a foreground collect with the same copy when the pool is full', async () => {
      const { ctx } = await mountWithPool({ value: true })
      const result = await call(ctx, { description: 'x', prompt: 't' }, agentWithCtx(ctx))
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toBe(`Error: ${LIVE_CAPACITY_REFUSAL}`)
    })

    it('T16: the pool refusal unblocks once activations drain (release_agent frees a resident slot)', async () => {
      const full = { value: true }
      const { ctx } = await mountWithPool(full)
      const refused = await call(ctx, { description: 'x', prompt: 't', run_in_background: true }, agentWithCtx(ctx))
      expect(refused.isError).toBe(true)
      expect(refused.content[0]!.text).toBe(`Error: ${LIVE_CAPACITY_REFUSAL}`)

      // release_agent drains a resident activation; the fake pool reflects
      // the freed slot by no longer refusing the next activation.
      registerReleaseAgentTool(ctx)
      const seam = ctx.get('subagents') as Record<string, unknown>
      seam['drainChildren'] = async (): Promise<void> => { full.value = false }
      // release_agent's liveness check consults the agents registry for the id.
      ctx.provide('agents', { get: (id: string) => (full.value && id === 'child-0' ? { status: 'running' } : undefined) })
      seam['listChildren'] = async (): Promise<{ id: string; mode: string }[]> => [{ id: 'child-0', mode: 'continuable' }]
      const agent = agentWithCtx(ctx)
      const released = (await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'call-release-1' as never,
        name: RELEASE_AGENT_TOOL,
        arguments: { agent_id: 'child-0' },
        agent,
      })) as ToolCallResult
      expect(released.isError).toBe(false)
      expect(released.content[0]!.text).toContain('Released agent child-0')

      const admitted = await call(ctx, { description: 'x', prompt: 't', run_in_background: true }, agentWithCtx(ctx))
      expect(admitted.isError).toBe(false)
    })

    it('maps the pool refusal on the ephemeral branch to the same D4 copy (no one-shot-specific literal)', async () => {
      const { ctx, runs, continuableStarts } = await mountWithPool({ value: true })
      const ws = freshWorkspace()
      writeAgent(ws, 'scout', '---\nname: scout\ndescription: S\ntools:\n  - Read\n---\nScout body.\n')
      const result = await call(ctx, { subagent_type: 'scout', description: 'x', prompt: 't' }, agentWithCtx(ctx, ws))
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toBe(`Error: ${LIVE_CAPACITY_REFUSAL}`)
      expect(result.content[0]!.text).not.toContain('ephemeral/one-shot runs in flight')
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(0)
    })

    it('delegates capacity to the harness pool (no listChildren pre-count on any lane)', async () => {
      const { ctx, continuableStarts } = await mount()
      const listChildren = vi.fn(async () => [])
      const seam = ctx.get('subagents') as Record<string, unknown>
      seam['listChildren'] = listChildren
      const ws = freshWorkspace()
      writeAgent(ws, 'scout', '---\nname: scout\ndescription: S\ntools:\n  - Read\n---\nScout body.\n')
      const backgrounded = await call(ctx, { description: 'x', prompt: 't', run_in_background: true }, agentWithCtx(ctx))
      expect(backgrounded.isError).toBe(false)
      const ephemeral = await call(ctx, { subagent_type: 'scout', description: 'x', prompt: 't' }, agentWithCtx(ctx, ws))
      expect(ephemeral.isError).toBe(false)
      expect(continuableStarts).toHaveLength(1)
      // rc.5: the running-count guard is deleted; admission decisions belong
      // to the harness pool, so the lanes never consult the child catalog.
      expect(listChildren).not.toHaveBeenCalled()
    })

    it('T17: an armed foreground collect of a marked-releasing child resolves the aborted branch with the released-specific copy', async () => {
      const agentWithId = (id: string): Agent =>
        ({ id, session: { header: { cwd: '/any' } } } as unknown as Agent)
      const { ctx, startedChildIds, emitEnd } = await mount({ seamProviders: [pendingProvider()] })
      const pending = call(ctx, { description: 'x', prompt: 't' }, agentWithId('parent-rel'))
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(collectorsForSession('parent-rel')).toHaveLength(1)
      markReleasing(startedChildIds[0]!)
      emitEnd(startedChildIds[0]!, { stopReason: 'aborted' })
      const result = await pending
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toBe(
        `Error: subagent ${startedChildIds[0]} was released (or its release was in flight) `
        + 'while it was being collected; it cannot be continued in this session.',
      )
      resetReleasedMarkers()
    })

    it('the fork sentinel stays outside the continuable admission path (no lease, no pool wrap)', async () => {
      const { ctx, runs, continuableStarts } = await mount()
      const result = await call(ctx, { subagent_type: 'fork', description: 'x', prompt: 't' }, agentWithCtx(ctx))
      expect(result.isError).toBe(false)
      expect(runs).toHaveLength(1)
      expect(continuableStarts).toHaveLength(0)
    })
  })

  describe('D5 background-section release guidance', () => {
    it('carries the qualified session-exit bullet verbatim', () => {
      expect(BACKGROUND_SECTION_TEXT).toContain(
        '- Exiting your session drains every background child\'s in-flight turn (whole-forest teardown); '
        + 'its persisted session survives on disk — a child that settled on its own stays cold-resumable, '
        + 'but a DRAINED child does not resume on the next send_message (known upstream gap; '
        + 'cross-session resume after a drain is unverified).',
      )
      expect(BACKGROUND_SECTION_TEXT).not.toContain('cold-resumes on the next `send_message`')
    })

    it('carries the reconciled capacity + auto-release bullet (R8/R9)', () => {
      expect(BACKGROUND_SECTION_TEXT).toContain(
        '- A background child holds one of 25 tree-wide resident capacity slots until it is disposed or '
        + 'released — running children, idle parents waiting on child settlement, and cold-resumed '
        + 'children all count; a send_message follow-up to an already-resident child takes no new slot, '
        + 'while a cold resume of a settled child needs one and is refused at the cap with the same remedy. '
        + 'A settled child auto-releases after its inactivity grace '
        + 'window (foreground deliveries 30 minutes, background 2 hours; a definition\'s `autoReleaseMs` '
        + 'frontmatter overrides this, `0` disables) — after expiry its send_message is refused, so '
        + 'send_message promptly if you plan to continue it. release_agent <id> remains the interactive '
        + 'override for a RUNNING child: it evicts the resident activation (and resident descendants\') '
        + 'one-way — same-session continuation is unavailable after release; its persisted session survives; '
        + 'eviction is cooperative — a cancel-resistant turn keeps its slot until it settles.',
      )
      // R8 reconciliation: auto-tombstone is the routine lane; manual release
      // is scoped to RUNNING children.
      expect(BACKGROUND_SECTION_TEXT).toMatch(/auto-releases after its inactivity grace window/)
      expect(BACKGROUND_SECTION_TEXT).toMatch(/interactive override for a RUNNING child/)
      expect(BACKGROUND_SECTION_TEXT).not.toContain('not as routine cleanup')
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
      expect(result.content[0]!.text).toMatch(/^done \(auto-released after 30 minutes of inactivity, expires \d{2}:\d{2}\)$/)
      expect(collectorsForSession('parent-s')).toEqual([])
    })

    it('teaches the promotion clause in the tool description and the background section', () => {
      expect(BACKGROUND_SECTION_TEXT).toMatch(/backgroundedByUser: true/)
      expect(BACKGROUND_SECTION_TEXT).toMatch(/later wake/)
    })
  })
})

describe('def.effort spawn fold', () => {
  const writeEffortAgent = (ws: string, name: string, model: string, effort?: string): void => {
    writeAgent(ws, name, `---\nname: ${name}\ndescription: x\nmodel: ${model}\n${effort === undefined ? '' : `effort: ${effort}\n`}---\nBody.\n`)
  }

  it('frontmatter def.effort applies when the route carries no effort', async () => {
    const ws = freshWorkspace()
    writeEffortAgent(ws, 'deep-reasoner', 'opus', 'low')
    const routes = { resolve: (m: string | undefined) => m === 'opus' ? { provider: 'o', model: 'glm-5.3' } : undefined }
    const { ctx, continuableStarts } = await mount({ routes })
    await call(ctx, { subagent_type: 'deep-reasoner', description: 'x', prompt: 't' }, agentAt(ws))
    expect(continuableStarts[0]!.request['agentOptions']).toEqual({
      provider: 'o',
      model: 'glm-5.3',
      reasoningEffort: 'low',
    })
  })

  it('route effort wins over frontmatter def.effort', async () => {
    const ws = freshWorkspace()
    writeEffortAgent(ws, 'deep-reasoner', 'opus', 'low')
    const routes = {
      resolve: (m: string | undefined) => m === 'opus'
        ? { provider: 'o', model: 'glm-5.3', reasoningEffort: 'high' }
        : undefined,
    }
    const { ctx, continuableStarts } = await mount({ routes })
    await call(ctx, { subagent_type: 'deep-reasoner', description: 'x', prompt: 't' }, agentAt(ws))
    expect(continuableStarts[0]!.request['agentOptions']).toMatchObject({ reasoningEffort: 'high' })
  })

  it('neither route nor def effort: no reasoningEffort key', async () => {
    const ws = freshWorkspace()
    writeEffortAgent(ws, 'fast-worker', 'sonnet')
    const routes = { resolve: (m: string | undefined) => m === 'sonnet' ? { model: 'glm-5.3' } : undefined }
    const { ctx, continuableStarts } = await mount({ routes })
    await call(ctx, { subagent_type: 'fast-worker', description: 'x', prompt: 't' }, agentAt(ws))
    expect(continuableStarts[0]!.request['agentOptions']).toEqual({ model: 'glm-5.3' })
  })
})
