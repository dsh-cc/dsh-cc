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
import { AgentRegistry } from '../src/registry.ts'
import { mountAgentCatalog, CATALOG_SECTION_NAME } from '../src/catalog.ts'

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
async function mount() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
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
