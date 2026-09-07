/**
 * Tests for the per-agent "Available subagents" catalog section: a single
 * global section registration whose `text(context)` renders the agent's own
 * workspace definitions via `context.scope`, lazily loading on first sight
 * and publishing `system-prompt/change` when the catalog lands. Tests drive
 * the REAL assembly path (`ctx.plugin(SystemPrompt)` then
 * `ctx.systemPrompt.assemble`) rather than poking private APIs.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { AgentDefinition } from '@dsh-cc/claude-code-agents'
import { AgentProvider } from '@dsh-cc/plugin-loader'
import { AgentRegistry } from '../src/registry.ts'
import { PluginAgentIndex } from '../src/plugin-agents.ts'
import { mountAgentCatalog, CATALOG_SECTION_NAME } from '../src/catalog.ts'
import type { SubagentsLike } from '../src/background-start.ts'

const tmpRoots: string[] = []

function freshDir(...parts: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-catalog-'))
  tmpRoots.push(dir)
  const target = parts.length > 0 ? join(dir, ...parts) : dir
  mkdirSync(target, { recursive: true })
  return target
}

function writeAgent(root: string, name: string, description: string): void {
  const agents = join(root, '.claude', 'agents')
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`, 'utf8')
}

function agentAt(cwd: string): Agent {
  return { session: { header: { cwd } } } as unknown as Agent
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Mount the real SystemPrompt seam + catalog, returning a scoped assembler. */
async function mount(opts: { seam?: SubagentsLike } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  if (opts.seam !== undefined) ctx.provide('subagents', opts.seam)
  const registry = new AgentRegistry()
  mountAgentCatalog(ctx, registry)
  // Assemble with a scope and read our section's rendered text ('' when the
  // section is absent from the assembly).
  const textOf = async (scope: unknown): Promise<string> => {
    const assembly = await ctx.systemPrompt.assemble(scope === undefined ? {} : { scope })
    return assembly.sections.find(s => s.name === CATALOG_SECTION_NAME)?.text ?? ''
  }
  return { ctx, registry, textOf }
}

/** A plugin agent provider fixture: a REAL loader `AgentProvider` (branded),
 * registered under its scoped id exactly as `mountAgents` does. */
function pluginSeamEntry(id: string, whenToUse: string): AgentProvider {
  const bare = id.split(':').pop()!
  const definition = {
    agentType: bare,
    whenToUse,
    systemPrompt: `You are ${id}.`,
  } as AgentDefinition
  return new AgentProvider(definition, () => undefined, undefined, id)
}

/** A brandless provider that fakes the AgentProvider shape (plan §9.4). */
function brandlessSeamEntry(id: string, whenToUse: string): unknown {
  const bare = id.split(':').pop()!
  return {
    name: id,
    definition: { agentType: bare, whenToUse, systemPrompt: `You are ${id}.` },
    start: async () => ({}),
  }
}

/** A mutable fake seam holding plugin agent providers. */
function fakePluginSeam(): {
  seam: SubagentsLike
  register(entry: unknown): () => void
  /** Wire lifecycle-event delivery to a host context (the real seam emits
   * `subagent/provider-added` / `subagent/provider-removed` on its ctx). */
  notify(fn: (event: string, arg: unknown) => void): void
} {
  const byName = new Map<string, unknown>()
  let emit: ((event: string, arg: unknown) => void) | undefined
  const seam = {
    async start() { throw new Error('not used') },
    getProvider: (name: string) => byName.get(name),
    list: () => [...byName.keys()],
  } as unknown as SubagentsLike
  return {
    seam,
    register(entry) {
      byName.set((entry as { name: string }).name, entry)
      emit?.('subagent/provider-added', entry)
      return () => {
        byName.delete((entry as { name: string }).name)
        emit?.('subagent/provider-removed', (entry as { name: string }).name)
      }
    },
    notify(fn) { emit = fn },
  }
}

describe('AgentCatalog section', () => {
  it('renders each agent its own workspace catalog, lazily, after a change event', async () => {
    const wsA = freshDir('ws-a')
    const wsB = freshDir('ws-b')
    writeAgent(wsA, 'deep-reasoner', 'Review heavy work')
    writeAgent(wsB, 'fast-worker', 'Mechanical execution')
    const { ctx, textOf } = await mount()

    const changes = vi.fn()
    ctx.on('system-prompt/change', changes)

    // The first assembly kicks background discovery; once it lands the change
    // event fires and a later assembly picks up the populated catalog.
    await vi.waitFor(async () => {
      const text = await textOf(agentAt(wsA))
      expect(text).toContain('deep-reasoner')
      expect(text).toContain('Review heavy work')
    }, { timeout: 2000 })
    await vi.waitFor(async () => {
      expect(await textOf(agentAt(wsB))).toContain('fast-worker')
    }, { timeout: 2000 })

    // The change event fired after the lazy loads completed.
    expect(changes).toHaveBeenCalled()

    // Each agent sees only its own workspace's agents.
    const a = await textOf(agentAt(wsA))
    expect(a).toContain('## Available subagents')
    expect(a).toContain('deep-reasoner')
    expect(a).not.toContain('fast-worker')
    expect(a).toContain('subagent_type')
    const b = await textOf(agentAt(wsB))
    expect(b).toContain('fast-worker')
    expect(b).not.toContain('deep-reasoner')

    await ctx.fiber.dispose()
  })

  it('keeps two loaded workspaces isolated from each other', async () => {
    const wsA = freshDir('ws-a')
    const wsB = freshDir('ws-b')
    writeAgent(wsA, 'deep-reasoner', 'Review heavy work')
    writeAgent(wsB, 'fast-worker', 'Mechanical execution')
    const { ctx, textOf } = await mount()

    // Both loaded.
    await vi.waitFor(async () => {
      expect(await textOf(agentAt(wsA))).toContain('deep-reasoner')
      expect(await textOf(agentAt(wsB))).toContain('fast-worker')
    }, { timeout: 2000 })

    expect(await textOf(agentAt(wsA))).not.toContain('fast-worker')
    expect(await textOf(agentAt(wsB))).not.toContain('deep-reasoner')
    await ctx.fiber.dispose()
  })

  it('renders the bundled agents for a workspace with no agents of its own', async () => {
    const empty = freshDir('empty')
    const { ctx, textOf } = await mount()
    // Let discovery settle, then assert the bundled catalog is rendered.
    await vi.waitFor(async () => {
      await ctx.systemPrompt.assemble({ scope: agentAt(empty) })
    })
    const text = await textOf(agentAt(empty))
    expect(text).toContain('## Available subagents')
    expect(text).toContain('explore')
    expect(text).toContain('dsh-cc-guide')
    await ctx.fiber.dispose()
  })

  it('a project explore.md shadows the bundled explore description', async () => {
    const ws = freshDir('ws')
    writeAgent(ws, 'explore', 'Project-local explore override')
    const { ctx, textOf } = await mount()
    await vi.waitFor(async () => {
      expect(await textOf(agentAt(ws))).toContain('Project-local explore override')
    }, { timeout: 2000 })
    expect(await textOf(agentAt(ws))).not.toContain('Fast, read-only codebase scout')
    await ctx.fiber.dispose()
  })

  it('renders nothing for a non-agent scope', async () => {
    const ws = freshDir('ws')
    writeAgent(ws, 'deep-reasoner', 'Review heavy work')
    const { ctx, textOf } = await mount()
    expect(await textOf({})).toBe('')
    await ctx.fiber.dispose()
  })

  it('lists plugin agents with their scoped ids beside the workspace definitions', async () => {
    const ws = freshDir('ws')
    writeAgent(ws, 'deep-reasoner', 'Review heavy work')
    const plugin = fakePluginSeam()
    plugin.register(pluginSeamEntry('p:researcher', 'Plugin research'))
    const { ctx, textOf } = await mount({ seam: plugin.seam })
    await vi.waitFor(async () => {
      const text = await textOf(agentAt(ws))
      expect(text).toContain('- p:researcher — Plugin research')
      expect(text).toContain('- deep-reasoner — Review heavy work')
    }, { timeout: 2000 })
    // Sorted: the scoped id lands in one merged list (p after d).
    const text = await textOf(agentAt(ws))
    expect(text.indexOf('deep-reasoner')).toBeLessThan(text.indexOf('p:researcher'))
    await ctx.fiber.dispose()
  })

  it('fires system-prompt/change from the lifecycle listener (never inside a render frame) when a branded provider registers after mount', async () => {
    const ws = freshDir('ws')
    const plugin = fakePluginSeam()
    const { ctx, textOf } = await mount({ seam: plugin.seam })
    // Deliver the seam's lifecycle events on the same cordis bus the real
    // harness seam uses (realm-delivery check: the listener must receive the
    // event even for a provider registered AFTER the catalog mounted).
    plugin.notify((event, arg) => ctx.emit(event as Parameters<typeof ctx.emit>[0], arg))
    const stacks: string[] = []
    ctx.on('system-prompt/change', () => { stacks.push(new Error().stack ?? '') })

    plugin.register(pluginSeamEntry('p:researcher', 'Plugin research'))
    await vi.waitFor(() => {
      expect(stacks.length).toBeGreaterThan(0)
    }, { timeout: 2000 })
    // The change event came from the lifecycle listener, NEVER from inside a
    // render frame (render is side-effect-free now).
    expect(stacks.some(stack => /AgentCatalogSection/.test(stack))).toBe(false)
    // Render is side-effect-free: warm assemblies with no lifecycle event
    // emit nothing new.
    await vi.waitFor(async () => {
      expect(await textOf(agentAt(ws))).toContain('p:researcher')
    }, { timeout: 2000 })
    const before = stacks.length
    await textOf(agentAt(ws))
    await textOf(agentAt(ws))
    expect(stacks.length).toBe(before)
    await ctx.fiber.dispose()
  })

  it('a brandless definition-shaped provider add does NOT fire system-prompt/change', async () => {
    const ws = freshDir('ws')
    const plugin = fakePluginSeam()
    const { ctx, textOf } = await mount({ seam: plugin.seam })
    plugin.notify((event, arg) => ctx.emit(event as Parameters<typeof ctx.emit>[0], arg))
    const changes = vi.fn()
    ctx.on('system-prompt/change', changes)

    plugin.register(brandlessSeamEntry('p:fake', 'Fake research'))
    // Settle the workspace discovery's own change event (ensureDefs) so the
    // remaining count isolates plugin-lifecycle emits.
    await vi.waitFor(async () => {
      expect(await textOf(agentAt(ws))).toBeDefined()
      expect(changes).toHaveBeenCalled()
    }, { timeout: 2000 })
    changes.mockClear()
    await textOf(agentAt(ws))
    expect(changes).not.toHaveBeenCalled()
    expect(await textOf(agentAt(ws))).not.toContain('p:fake')
    await ctx.fiber.dispose()
  })

  it('fires system-prompt/change when a provider is removed and drops the id from the next render', async () => {
    const ws = freshDir('ws')
    const plugin = fakePluginSeam()
    const { ctx, textOf } = await mount({ seam: plugin.seam })
    plugin.notify((event, arg) => ctx.emit(event as Parameters<typeof ctx.emit>[0], arg))
    const disposeProvider = plugin.register(pluginSeamEntry('p:researcher', 'Plugin research'))
    await vi.waitFor(async () => {
      expect(await textOf(agentAt(ws))).toContain('p:researcher')
    }, { timeout: 2000 })

    const changes = vi.fn()
    ctx.on('system-prompt/change', changes)
    disposeProvider()
    await vi.waitFor(() => {
      expect(changes).toHaveBeenCalled()
    }, { timeout: 2000 })
    expect(await textOf(agentAt(ws))).not.toContain('p:researcher')
    await ctx.fiber.dispose()
  })
})

/**
 * The assemble-waterfall reconciliation: while a workspace's discovery is
 * still in flight, the assemble waterfall listener joins it (bounded) so the
 * FIRST assembly for that scope already carries the real catalog instead of
 * the placeholder — the first-turn request-2 prefix must not diverge.
 */
describe('AgentCatalog assemble waterfall', () => {
  /** A controllable stand-in for the per-root discovery promise. */
  function deferredDefs(): {
    promise: Promise<ReadonlyMap<string, AgentDefinition>>
    resolve: (defs: ReadonlyMap<string, AgentDefinition>) => void
  } {
    let resolve!: (defs: ReadonlyMap<string, AgentDefinition>) => void
    const promise = new Promise<ReadonlyMap<string, AgentDefinition>>((res) => { resolve = res })
    return { promise, resolve }
  }

  /** A registry whose `ensure` always returns one shared pending promise. */
  class FakeRegistry extends AgentRegistry {
    calls = 0
    constructor(private readonly pending: Promise<ReadonlyMap<string, AgentDefinition>>) {
      super()
    }
    override ensure(_root: string): Promise<ReadonlyMap<string, AgentDefinition>> {
      this.calls++
      return this.pending
    }
  }

  /** Mount the catalog over a fake registry, as `mount` does. */
  async function mountWithRegistry(registry: AgentRegistry) {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    mountAgentCatalog(ctx, registry)
    const textOf = async (scope: unknown): Promise<string> => {
      const assembly = await ctx.systemPrompt.assemble(scope === undefined ? {} : { scope })
      return assembly.sections.find(s => s.name === CATALOG_SECTION_NAME)?.text ?? ''
    }
    return { ctx, textOf }
  }

  function oneDef(type: string, whenToUse: string): ReadonlyMap<string, AgentDefinition> {
    return new Map([[type, { agentType: type, whenToUse } as AgentDefinition]])
  }

  it('first assembly already carries the real catalog once discovery resolves', async () => {
    const ws = freshDir('ws')
    const deferred = deferredDefs()
    const registry = new FakeRegistry(deferred.promise)
    const { ctx, textOf } = await mountWithRegistry(registry)

    // The FIRST assembly must block on the in-flight discovery, not return
    // the placeholder: resolve the gate, then read that same assembly.
    const pending = textOf(agentAt(ws))
    deferred.resolve(oneDef('deep-reasoner', 'Review heavy work'))
    const text = await pending

    expect(text).toContain('## Available subagents')
    expect(text).toContain('deep-reasoner')
    expect(text).toContain('Review heavy work')
    await ctx.fiber.dispose()
  })

  it('warm assemblies are byte-identical and perform no further discovery', async () => {
    const ws = freshDir('ws')
    const deferred = deferredDefs()
    const registry = new FakeRegistry(deferred.promise)
    const { ctx, textOf } = await mountWithRegistry(registry)

    const pending = textOf(agentAt(ws))
    deferred.resolve(oneDef('fast-worker', 'Mechanical execution'))
    const first = await pending

    const second = await textOf(agentAt(ws))
    expect(second).toBe(first)
    // One call from the render's background kick + one join from the
    // waterfall listener; the warm assembly adds none.
    expect(registry.calls).toBe(2)
    await ctx.fiber.dispose()
  })

  it('degrades to the placeholder when discovery exceeds the readiness budget', async () => {
    const ws = freshDir('ws')
    const deferred = deferredDefs() // never resolves
    vi.useFakeTimers()
    try {
      const { ctx, textOf } = await mountWithRegistry(new FakeRegistry(deferred.promise))
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

      const pending = textOf(agentAt(ws))
      await vi.advanceTimersByTimeAsync(501)
      expect(await pending).toBe('')
      expect(warn).toHaveBeenCalledOnce()
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes a scope-less assembly through without awaiting discovery', async () => {
    const deferred = deferredDefs() // never resolves
    const { ctx, textOf } = await mountWithRegistry(new FakeRegistry(deferred.promise))
    // Must settle promptly (a listener that awaited would hang this test).
    expect(await textOf(undefined)).toBe('')
    expect(await textOf({})).toBe('')
    await ctx.fiber.dispose()
  })
})
