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
import {
  AgentCatalogSection,
  mountAgentCatalog,
  renderCatalog,
  CATALOG_SECTION_NAME,
} from '../src/catalog.ts'
import {
  DEFAULT_SUBAGENT_CATALOG_SETTINGS,
  SUBAGENT_CATALOG_NAMESPACE,
  registerSubagentCatalogSettings,
  resolveSubagentCatalogSettings,
} from '../src/catalog-settings.ts'
import type { SubagentCatalogSettings } from '../src/catalog-settings.ts'
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

  it('fires system-prompt/change when a provider mounted BEFORE the catalog listener starts is removed', async () => {
    const ws = freshDir('ws')
    const plugin = fakePluginSeam()
    // Register BEFORE the catalog mounts — production mounts cc-shell-glue
    // before subagent-task, so initial providers' add events predate the
    // listener; their removals must still invalidate the prompt.
    const disposeProvider = plugin.register(pluginSeamEntry('p:researcher', 'Plugin research'))
    const { ctx, textOf } = await mount({ seam: plugin.seam })
    plugin.notify((event, arg) => ctx.emit(event as Parameters<typeof ctx.emit>[0], arg))
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

  it('degrades to a bundled-seeded placeholder when discovery exceeds the readiness budget', async () => {
    const ws = freshDir('ws')
    const deferred = deferredDefs() // never resolves
    vi.useFakeTimers()
    try {
      const { ctx, textOf } = await mountWithRegistry(new FakeRegistry(deferred.promise))
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

      const pending = textOf(agentAt(ws))
      await vi.advanceTimersByTimeAsync(501)
      const text = await pending
      // The placeholder must STILL list the in-package agents. While
      // discovery was in flight the catalog used to render NOTHING from the
      // file layer — observed in the wild as a model planning over a prompt
      // in which `explore` did not exist and consequently spawning
      // general-purpose children on the main model's route. A slow scan is
      // transient; a missing catalog entry steers the whole session.
      expect(text).toContain('## Available subagents')
      expect(text).toContain('explore')
      expect(text).toContain('dsh-cc-guide')
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

/**
 * The `cc-subagent-catalog` byte budget (design
 * docs/plans/2026-11-12-selective-system-prompt-sections.md §B): every size
 * is a UTF-8 byte count, every slice cuts on char boundaries, names survive
 * down to the names-only collapse, and the oversized-names floor is the ONLY
 * form that drops names — always with the documented overflow line.
 */
describe('renderCatalog byte budget', () => {
  /** A roster line with a byte-measurable whenToUse. */
  const defOf = (agentType: string, whenToUse: string): AgentDefinition =>
    ({ agentType, whenToUse }) as AgentDefinition

  /** `count` agents with `textLength`-byte ASCII whenToUse each. */
  const roster = (count: number, textLength: number): AgentDefinition[] =>
    Array.from({ length: count }, (_, i) =>
      defOf(`agent-${String(i).padStart(2, '0')}`, 'x'.repeat(textLength)))

  const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8')
  const HEADER = '## Available subagents'
  const TRAILER = 'To delegate to one, pass its name as the `subagent_type` argument of the Task tool.'
  const legacy = (defs: readonly AgentDefinition[]): string =>
    [HEADER, '', ...defs.map(def => `- ${def.agentType} — ${def.whenToUse}`), '', TRAILER].join('\n')
  const NAMES_ONLY_NOTE = /… \(\d+ more agents listed by name only\)/
  const FLOOR_NOTE = /… \(\d+ more agents omitted by cc-subagent-catalog\.max-bytes; the catalog's usage line stays\)/
  const settings = (over: Partial<SubagentCatalogSettings> = {}): SubagentCatalogSettings =>
    ({ ...DEFAULT_SUBAGENT_CATALOG_SETTINGS, ...over })

  /** Text portion of the first roster line (after the `— ` separator). */
  const textOfFirstLine = (rendered: string): string => {
    const line = rendered.split('\n').find(entry => entry.startsWith('- ')) ?? ''
    return line.slice(line.indexOf('—') + 2)
  }

  it('renders byte-identical text when the roster fits the cap', () => {
    const defs = roster(5, 30)
    expect(renderCatalog(defs, settings())).toBe(legacy(defs))
  })

  it('keeps every agentType name while truncating entry text (pass 1)', () => {
    const defs = roster(10, 400)
    const rendered = renderCatalog(defs, settings({ maxBytes: 1024, minEntryBytes: 20 }))
    expect(bytesOf(rendered)).toBeLessThanOrEqual(1024)
    for (const def of defs) expect(rendered).toContain(def.agentType)
    // Pass 1 truncates text only: no names-only line, no names dropped.
    expect(rendered).not.toMatch(NAMES_ONLY_NOTE)
    expect(rendered).not.toMatch(FLOOR_NOTE)
    expect(rendered).toContain(HEADER)
    expect(rendered).toContain(TRAILER)
  })

  it('honours the min-entry-bytes floor for the per-entry slice', () => {
    const defs = roster(10, 400)
    const small = renderCatalog(defs, settings({ maxBytes: 1024, minEntryBytes: 20 }))
    const large = renderCatalog(defs, settings({ maxBytes: 1024, minEntryBytes: 400 }))
    // min-entry-bytes: 400 binds, so a kept entry's text is exactly 400 bytes.
    expect(bytesOf(textOfFirstLine(large))).toBe(400)
    expect(bytesOf(textOfFirstLine(small))).toBeLessThan(400)
    // A larger floor leaves room for fewer full entries: the tail collapses.
    expect(small).not.toMatch(NAMES_ONLY_NOTE)
    expect(large).toMatch(NAMES_ONLY_NOTE)
    for (const rendered of [small, large]) expect(bytesOf(rendered)).toBeLessThanOrEqual(1024)
  })

  it('slices a CJK whenToUse on char boundaries without overflowing the cap', () => {
    const cjkText = '日本語の説明'.repeat(60)
    const rendered = renderCatalog([defOf('cjk-agent', cjkText)], settings({ maxBytes: 1024, minEntryBytes: 20 }))
    expect(bytesOf(rendered)).toBeLessThanOrEqual(1024)
    // A char-boundary cut can never produce U+FFFD or split a 3-byte sequence.
    expect(rendered).not.toContain('\uFFFD')
    const sliced = textOfFirstLine(rendered)
    expect(bytesOf(sliced) % 3).toBe(0)
    // The slice is a true prefix of the original text, not a re-encoding.
    expect(cjkText.startsWith(sliced)).toBe(true)
  })

  it('collapses the tail into one names-only line when the cap still bites (pass 2)', () => {
    const defs = roster(60, 100)
    const rendered = renderCatalog(defs, settings({ maxBytes: 1024, minEntryBytes: 40 }))
    expect(bytesOf(rendered)).toBeLessThanOrEqual(1024)
    // Name preservation: the collapse lists EVERY remaining agentType.
    for (const def of defs) expect(rendered).toContain(def.agentType)
    expect(rendered).toMatch(NAMES_ONLY_NOTE)
    expect(rendered).not.toMatch(FLOOR_NOTE)
    expect(rendered).toContain(TRAILER)
  })

  it('drops names only through the documented oversized-names floor line', () => {
    const names = Array.from({ length: 8 }, (_, i) => `${'n'.repeat(400)}-${i}`)
    const defs = names.map(name => defOf(name, 'text'))
    const rendered = renderCatalog(defs, settings({ maxBytes: 1024, minEntryBytes: 40 }))
    expect(bytesOf(rendered)).toBeLessThanOrEqual(1024)
    const kept = names.filter(name => rendered.includes(name)).length
    expect(kept).toBeLessThan(names.length)
    // The dropped count is spelled out, never silent.
    const note = FLOOR_NOTE.exec(rendered)
    expect(note).not.toBeNull()
    expect(note?.[0]).toContain(`${names.length - kept} more agents omitted`)
    expect(rendered).toContain(TRAILER)
  })

  it('renders the roster uncapped when truncate is false', () => {
    const defs = roster(60, 100)
    const rendered = renderCatalog(defs, settings({ truncate: false, maxBytes: 1024, minEntryBytes: 40 }))
    expect(rendered).toBe(legacy(defs))
    expect(bytesOf(rendered)).toBeGreaterThan(1024)
  })

  it('treats the one-argument form as the design defaults', () => {
    const defs = roster(60, 100)
    expect(renderCatalog(defs)).toBe(renderCatalog(defs, DEFAULT_SUBAGENT_CATALOG_SETTINGS))
  })

  it('never exceeds max-bytes over random rosters (non-floor and floor alike)', () => {
    let seed = 7
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const pools = ['abcdefghij', '日本語の説明文章', '🙂🙃🚀', 'ascii + 漢字 + 🙂']
    const limits = [1024, 1500, 4096, 8192, 20000]
    const floors = [20, 40, 200, 400]
    /** Pick one element with the seeded PRNG (index access is bounds-safe here). */
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T
    for (let round = 0; round < 120; round++) {
      const count = 1 + Math.floor(next() * 40)
      const defs = Array.from({ length: count }, (_, i) => {
        const pool = pick(pools)
        let name = ''
        const nameBytes = 1 + Math.floor(next() * (next() < 0.1 ? 120 : 18))
        while (bytesOf(name) < nameBytes) name += pick([...pool])
        let text = ''
        const textBytes = Math.floor(next() * 500)
        while (bytesOf(text) < textBytes) text += pick([...pool])
        return defOf(`${name}-${i}`, text)
      }).sort((a, b) => a.agentType.localeCompare(b.agentType))
      const maxBytes = pick(limits)
      const rendered = renderCatalog(defs, {
        truncate: true,
        maxBytes,
        minEntryBytes: pick(floors),
      })
      expect(bytesOf(rendered)).toBeLessThanOrEqual(maxBytes)
      expect(rendered).toContain(HEADER)
      expect(rendered).toContain(TRAILER)
      // A names-only collapse still carries every name; only the floor drops.
      if (rendered.match(NAMES_ONLY_NOTE)) {
        for (const def of defs) expect(rendered).toContain(def.agentType)
      }
      const floor = FLOOR_NOTE.exec(rendered)
      const dropped = defs.filter(def => !rendered.includes(def.agentType)).length
      if (dropped > 0) {
        expect(floor).not.toBeNull()
        expect(floor?.[0]).toContain(`${dropped} more agents omitted`)
      }
    }
  })
})

/**
 * The `cc-subagent-catalog` settings namespace: the live reader (per-use
 * re-read, defaults without a provider) and the per-render threading through
 * the shared `render()` so the ordinary path, the readiness re-render and the
 * `system-prompt/change` re-render all honour a mid-session settings write.
 */
describe('cc-subagent-catalog settings', () => {
  /**
   * Minimal provider double mirroring the real provider's resolution contract
   * closely enough for the reader: `register` resolves the section through the
   * schema and `get` returns the latest resolved value.
   */
  function fakeProvider(): {
    provider: {
      register: (ns: string, schema: (input: unknown) => unknown) => { get: () => unknown }
      get: (ns: string) => unknown
    }
    update: (section: Record<string, unknown>) => void
  } {
    let schema: ((input: unknown) => unknown) | undefined
    let resolved: unknown
    const resolve = (section: Record<string, unknown>): unknown => {
      if (schema === undefined) throw new Error('no registration')
      return schema(section)
    }
    return {
      provider: {
        register(ns, incoming) {
          if (schema !== undefined) throw new Error(`settings namespace "${ns}" is already registered`)
          schema = incoming
          resolved = resolve({})
          return { get: () => resolved }
        },
        get() {
          return resolved
        },
      },
      update(section) {
        resolved = resolve(section)
      },
    }
  }

  it('reads the design defaults without a settings provider', () => {
    const ctx = { get: () => undefined, inject: () => { throw new Error('no provider to inject') } }
    const read = registerSubagentCatalogSettings(ctx as never)
    expect(read()).toEqual(DEFAULT_SUBAGENT_CATALOG_SETTINGS)
    expect(DEFAULT_SUBAGENT_CATALOG_SETTINGS).toEqual({ truncate: true, maxBytes: 8192, minEntryBytes: 40 })
  })

  it('names the namespace exactly `cc-subagent-catalog`', () => {
    expect(SUBAGENT_CATALOG_NAMESPACE).toBe('cc-subagent-catalog')
  })

  it('maps the kebab-case section onto the camelCase settings', () => {
    expect(resolveSubagentCatalogSettings({
      truncate: false,
      'max-bytes': 2048,
      'min-entry-bytes': 200,
    })).toEqual({ truncate: false, maxBytes: 2048, minEntryBytes: 200 })
  })

  it('resolves an absent section and an absent key to the defaults', () => {
    expect(resolveSubagentCatalogSettings(undefined)).toEqual(DEFAULT_SUBAGENT_CATALOG_SETTINGS)
    expect(resolveSubagentCatalogSettings({})).toEqual(DEFAULT_SUBAGENT_CATALOG_SETTINGS)
  })

  it('keeps the live reader hot: a settings write lands on the next read', () => {
    const { provider, update } = fakeProvider()
    const read = registerSubagentCatalogSettings({ get: (name: string) => name === 'settings' ? provider : undefined } as never)
    expect(read()).toEqual(DEFAULT_SUBAGENT_CATALOG_SETTINGS)
    update({ 'max-bytes': 1024, 'min-entry-bytes': 400 })
    expect(read()).toEqual({ truncate: true, maxBytes: 1024, minEntryBytes: 400 })
  })

  it('re-reads the budget on every render (hot getter through the shared render path)', async () => {
    const ws = freshDir('ws')
    for (let i = 0; i < 12; i++) writeAgent(ws, `agent-${String(i).padStart(2, '0')}`, 'd'.repeat(300))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const registry = new AgentRegistry()
    let live: SubagentCatalogSettings = { truncate: true, maxBytes: 1024, minEntryBytes: 40 }
    new AgentCatalogSection(ctx, registry, undefined, () => live).start()
    const textOf = async (): Promise<string> => {
      const assembly = await ctx.systemPrompt.assemble({ scope: agentAt(ws) })
      return assembly.sections.find(section => section.name === CATALOG_SECTION_NAME)?.text ?? ''
    }
    await vi.waitFor(async () => {
      expect(await textOf()).toContain('agent-00')
    }, { timeout: 2000 })

    const capped = await textOf()
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(1024)

    // The same section instance, no re-mount: the next assembly renders with
    // the new budget.
    live = { truncate: false, maxBytes: 1024, minEntryBytes: 40 }
    const uncapped = await textOf()
    expect(Buffer.byteLength(uncapped, 'utf8')).toBeGreaterThan(1024)
    expect(uncapped).toContain('d'.repeat(300))
    await ctx.fiber.dispose()
  })
})
