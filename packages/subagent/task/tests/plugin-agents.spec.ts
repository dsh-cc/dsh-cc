/**
 * Tests for the PluginAgentIndex: live enumeration of plugin agent providers
 * through the root-realm `ccPluginAgents` registry (§3.4.1 — the harness
 * subagents service no longer enumerates providers; the loader-written
 * snapshot is the authoritative source, and the provider EVENTS only
 * invalidate the catalog listener — they can no longer satisfy these tests).
 * The index reads the service lazily on every call, resolves by exact scoped
 * id, and renders its `isPluginAgentProvider` brand guard for the catalog's
 * event payloads.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountCcPlugin, AgentProvider } from '@dsh-cc/plugin-loader'
import type { CcPluginAgentsService } from '@dsh-cc/plugin-loader'
import { loadAgentsDir } from '@dsh-cc/claude-code-agents'
import type { AgentDefinition } from '@dsh-cc/claude-code-agents'
import { PluginAgentIndex, isPluginAgentProvider } from '../src/plugin-agents.ts'
import { registerTaskTool } from '../src/tool.ts'
import { AgentRegistry } from '../src/registry.ts'
import { renderCatalog } from '../src/catalog.ts'

const tmpRoots: string[] = []

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempPluginRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-agent-index-'))
  tmpRoots.push(root)
  return root
}

/**
 * A mutable fake `ccPluginAgents` service (the registry mountAgents publishes
 * in production) with direct record/remove levers.
 */
function fakeRegistry(): {
  service: CcPluginAgentsService
  record: (id: string, definition: AgentDefinition) => void
  remove: (id: string) => void
} {
  const byId = new Map<string, AgentDefinition>()
  return {
    service: {
      knownIds: () => [...byId.keys()],
      get: id => byId.get(id),
    },
    record: (id, definition) => { byId.set(id, definition) },
    remove: id => { byId.delete(id) },
  }
}

/** A ctx duck whose only service is the fake registry. */
function ctxOver(service: CcPluginAgentsService | undefined): Context {
  return { get: (key: string) => key === 'ccPluginAgents' ? service : undefined } as unknown as Context
}

function pluginDef(agentType: string, systemPrompt = `You are the ${agentType}.`): AgentDefinition {
  return {
    agentType,
    whenToUse: `${agentType} does things`,
    systemPrompt,
    source: 'project',
    baseDir: '/plugins/p/agents',
    filename: agentType,
  } as AgentDefinition
}

describe('PluginAgentIndex over the ccPluginAgents service', () => {
  it('lists real definitions with their scoped ids', async () => {
    const root = tempPluginRoot()
    mkdirSync(join(root, 'agents'), { recursive: true })
    writeFileSync(
      join(root, 'agents', 'researcher.md'),
      '---\ndescription: researcher agent\n---\nYou are the researcher.',
      'utf8',
    )
    const defs = await loadAgentsDir(join(root, 'agents'), 'project')
    expect(defs).toHaveLength(1)
    const registry = fakeRegistry()
    // Exactly what mountAgents records under a namespacePrefix.
    registry.record(`p:${defs[0]!.agentType}`, defs[0]!)
    const index = new PluginAgentIndex(ctxOver(registry.service))
    expect(index.list()).toEqual([
      { id: 'p:researcher', definition: defs[0] },
    ])
    expect(index.resolve('p:researcher')).toBe(defs[0])
    expect(index.resolve('researcher')).toBeUndefined()
    expect(index.resolve('p:nope')).toBeUndefined()
    expect(index.knownIds()).toEqual(['p:researcher'])
  })

  it('sorts the listing deterministically by scoped id', () => {
    const registry = fakeRegistry()
    registry.record('z:omega', pluginDef('omega'))
    registry.record('a:alpha', pluginDef('alpha'))
    registry.record('m:middle', pluginDef('middle'))
    const index = new PluginAgentIndex(ctxOver(registry.service))
    expect(index.knownIds()).toEqual(['a:alpha', 'm:middle', 'z:omega'])
  })

  it('reads the service lazily: ids recorded AFTER index construction are seen (the pre-registration scenario)', () => {
    // The service is published and the index constructed BEFORE any plugin
    // registers (production mounts cc-shell-glue before subagent-task).
    const registry = fakeRegistry()
    const index = new PluginAgentIndex(ctxOver(registry.service))
    expect(index.list()).toEqual([])
    registry.record('p:researcher', pluginDef('researcher'))
    expect(index.list()).toHaveLength(1)
    expect(index.resolve('p:researcher')).toBeDefined()
    // …and a removal is seen too (live every call, no caching).
    registry.remove('p:researcher')
    expect(index.list()).toEqual([])
  })

  it('an absent service (no plugin loader mounted) reads as no plugin agents', () => {
    const index = new PluginAgentIndex(ctxOver(undefined))
    expect(index.list()).toEqual([])
    expect(index.knownIds()).toEqual([])
    expect(index.resolve('p:anything')).toBeUndefined()
  })

  it('the seamOverride substitutes the service for hermetic tests', () => {
    let service: CcPluginAgentsService | undefined
    const index = new PluginAgentIndex(ctxOver(undefined), { seam: () => service })
    expect(index.list()).toEqual([])
    const registry = fakeRegistry()
    registry.record('p:late', pluginDef('late'))
    service = registry.service
    expect(index.knownIds()).toEqual(['p:late'])
  })
})

describe('isPluginAgentProvider (the catalog event guard)', () => {
  it('accepts a loader-built AgentProvider with a scoped name and definition', () => {
    const provider = new AgentProvider(pluginDef('researcher'), (() => undefined) as never, undefined, 'p:researcher')
    expect(isPluginAgentProvider(provider)).toBe(true)
  })

  it('rejects builtin providers, brandless shape-fakes, and unscoped providers', () => {
    expect(isPluginAgentProvider({
      name: 'spawn',
      start: async () => ({}),
    })).toBe(false)
    // Shape-fake without the loader brand.
    expect(isPluginAgentProvider({
      name: 'p:fake',
      start: async () => ({}),
      definition: { agentType: 'fake', systemPrompt: 'You are fake.', whenToUse: 'fake' },
    })).toBe(false)
    // Unscoped loader provider (no namespacePrefix at mount).
    expect(isPluginAgentProvider(new AgentProvider(pluginDef('bare'), (() => undefined) as never))).toBe(false)
  })
})

/**
 * End-to-end Task dispatch of the REAL first-party plugin's agents
 * (docs/plans/2026-09-07-official-agents-plugin.md §5.2): the actual
 * `packages/plugin/dsh-cc-agents` dir mounted through the loader's
 * `mountAgents` (the exact production mount path), dispatched through the
 * real Task tool over a scripted continuable seam.
 */
describe('Task dispatch of the real dsh-cc-agents plugin (mounted from the repo)', () => {
  const REAL_PLUGIN_DIR = resolve(import.meta.dirname, '../../../plugin/dsh-cc-agents')

  /** A minimal agent facade the Task tool reads `cwd` from. */
  function agentAt(cwd: string): unknown {
    return { id: 'plugin-dispatch-parent', session: { header: { cwd } } }
  }

  /**
   * A dispatch-capable subagents seam: a continuable-capable `spawn` provider
   * plus the registerProvider/getProvider surface `mountAgents` consumes —
   * deliberately WITHOUT any enumeration (rc.5: the service has no `list`;
   * discovery rides the loader-written `ccPluginAgents` snapshot).
   * `startActivation` mirrors the harness: it emits `subagent/start`,
   * records the folded request, and settles the epoch.
   */
  function dispatchSeam(emit: (event: string, info: Record<string, unknown>) => void) {
    const providers = new Map<string, unknown>()
    providers.set('spawn', {
      name: 'spawn',
      prepareContinuable: async () => ({}),
      start: async () => ({ result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'REASONED OUTPUT' }] }) }),
    })
    const continuable: Array<Record<string, unknown>> = []
    const seam: Record<string, unknown> = {
      async startActivation(spec: Record<string, unknown>) {
        const providerName = spec['provider'] as string
        if (providers.get(providerName) === undefined) throw new Error(`unknown provider "${providerName}"`)
        const childId = (spec['childId'] as string | undefined) ?? `child-${continuable.length + 1}`
        const runId = `run-${continuable.length + 1}`
        emit('subagent/start', { runId, provider: providerName, id: childId, local: true })
        // rc.5 flat spec: strip the envelope; the rest is the folded request.
        const {
          provider: _ep, label: _el, signal: _es, delivery: _ed, childId: _ec, name: _en,
          ...request
        } = spec
        continuable.push(request)
        void (async () => {
          emit('subagent/end', {
            runId, provider: providerName, id: childId, local: true,
            stopReason: 'completed',
            lastAssistantMessage: [{ type: 'text', text: 'REASONED OUTPUT' }],
          })
        })()
        return {
          childId,
          messageId: 'm-1',
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'REASONED OUTPUT' }] }),
          dispose: () => Promise.resolve(),
        }
      },
      getProvider: (name: string) => providers.get(name),
      registerProvider: (provider: unknown) => {
        providers.set((provider as { name: string }).name, provider)
        return () => { providers.delete((provider as { name: string }).name) }
      },
    }
    return { seam, continuable }
  }

  /** Mount the real plugin's agents exactly as cc-shell-glue does, plus the Task tool. */
  async function setup() {
    const ctx = new Context()
    const emit = (event: string, info: Record<string, unknown>): void => {
      ;(ctx as unknown as { emit(event: string, info: unknown): void }).emit(event, info)
    }
    const { seam, continuable } = dispatchSeam(emit)
    ctx.provide('subagents', seam)
    // Minimal built-in known-names set: the shipped lists sanitize untouched.
    let taskDef: { execute(a: unknown, e: unknown): Promise<{ text: string; status?: string }> } | undefined
    ctx.provide('tools', {
      register: (def: never) => { taskDef = def as never; return () => {} },
      reserve: () => () => {},
      get: () => undefined,
      view: () => ({
        restrictableNames: new Set([
          'bash', 'read', 'read_image', 'grep', 'glob', 'write', 'edit',
          'job_output', 'job_kill', 'todo_write', 'NotebookEdit',
        ]),
      }),
    })
    // The exact production mount path (ccPlugins.ts): the loader reads the
    // nested `.claude-plugin/plugin.json` (name `dsh-cc-agents`) and scopes
    // the provider names with the manifest name.
    const mount = await mountCcPlugin(ctx, { root: REAL_PLUGIN_DIR })
    void mount // stays mounted: the providers must remain live for the dispatch
    const workspace = mkdtempSync(join(tmpdir(), 'plugin-agent-dispatch-'))
    tmpRoots.push(workspace)
    registerTaskTool(ctx, new AgentRegistry())
    expect(taskDef, 'Task tool registered').toBeDefined()
    return { ctx, continuable, workspace, taskDef: taskDef! }
  }

  it('mountAgents publishes the ccPluginAgents snapshot (and its disposers maintain it)', async () => {
    const ctx = new Context()
    const { seam } = dispatchSeam(() => {})
    ctx.provide('subagents', seam)
    const serviceBefore = ctx.get('ccPluginAgents') as CcPluginAgentsService | undefined
    expect(serviceBefore).toBeUndefined()
    const first = await mountCcPlugin(ctx, { root: REAL_PLUGIN_DIR })
    const service = ctx.get('ccPluginAgents') as CcPluginAgentsService | undefined
    expect(service).toBeDefined()
    expect([...service!.knownIds()].sort()).toEqual([
      'dsh-cc-agents:critic',
      'dsh-cc-agents:executor',
      'dsh-cc-agents:marathon',
    ])
    // Unmount: the providers' own disposers drop the entries, and with the
    // registry empty the root slot itself is cleared (no dead registry).
    first.dispose()
    expect((ctx as unknown as { root: Context }).root.get('ccPluginAgents', false)).toBeUndefined()
    // A remount re-provides from the cleared (stale) slot, entries and all.
    const second = await mountCcPlugin(ctx, { root: REAL_PLUGIN_DIR })
    const republished = ctx.get('ccPluginAgents') as CcPluginAgentsService | undefined
    expect(republished).toBeDefined()
    expect([...republished!.knownIds()].sort()).toEqual([
      'dsh-cc-agents:critic',
      'dsh-cc-agents:executor',
      'dsh-cc-agents:marathon',
    ])
    second.dispose()
    expect((ctx as unknown as { root: Context }).root.get('ccPluginAgents', false)).toBeUndefined()
  })

  it('two coexisting plugin mounts share one registry; each unmount removes only its own entries', async () => {
    const mkPlugin = (name: string, agentType: string): string => {
      const root = tempPluginRoot()
      mkdirSync(join(root, '.claude-plugin'), { recursive: true })
      writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }), 'utf8')
      mkdirSync(join(root, 'agents'), { recursive: true })
      writeFileSync(join(root, 'agents', `${agentType}.md`), `---\ndescription: ${agentType}\n---\nBody.\n`, 'utf8')
      return root
    }
    const ctx = new Context()
    const { seam } = dispatchSeam(() => {})
    ctx.provide('subagents', seam)
    const a = await mountCcPlugin(ctx, { root: mkPlugin('plug-a', 'alpha') })
    const b = await mountCcPlugin(ctx, { root: mkPlugin('plug-b', 'beta') })
    const service = ctx.get('ccPluginAgents') as CcPluginAgentsService
    expect([...service.knownIds()].sort()).toEqual(['plug-a:alpha', 'plug-b:beta'])
    a.dispose()
    expect([...service.knownIds()]).toEqual(['plug-b:beta'])
    expect(ctx.get('ccPluginAgents')).toBeDefined()
    b.dispose()
    expect((ctx as unknown as { root: Context }).root.get('ccPluginAgents', false)).toBeUndefined()
  })

  it('dispatches dsh-cc-agents:critic foreground: collected text returns (persona travels via composition)', async () => {
    const { continuable, workspace, taskDef } = await setup()
    const result = await taskDef.execute(
      { subagent_type: 'dsh-cc-agents:critic', description: 'reason', prompt: 'think hard', run_in_background: false },
      { agent: agentAt(workspace), signal: new AbortController().signal, token: 'tok-1' },
    )
    expect(result.status).toBe('completed')
    // R9: the completed foreground copy carries the arm-time grace clause.
    expect(result.text).toMatch(/^REASONED OUTPUT \(auto-released after 30 minutes of inactivity, expires \d{2}:\d{2}\)$/)

    expect(continuable).toHaveLength(1)
    const request = continuable[0]!
    // rc.5: persona/toolFilter no longer ride the start request — the
    // composition slice applies the definition's prompt and restriction to
    // the child.
    expect(request['persona']).toBeUndefined()
    expect(request['toolFilter']).toBeUndefined()
    // No routes service: the opus alias is unconfigured → no agentOptions.
    expect(request['agentOptions']).toBeUndefined()
  })

  it('the catalog lists all scoped ids', async () => {
    const { ctx } = await setup()
    const index = new PluginAgentIndex(ctx)
    expect(index.knownIds().sort()).toEqual([
      'dsh-cc-agents:critic',
      'dsh-cc-agents:executor',
      'dsh-cc-agents:marathon',
    ])
    const catalog = renderCatalog(
      index.list().map(entry => ({
        agentType: entry.id,
        whenToUse: entry.definition.whenToUse,
      }) as AgentDefinition),
    )
    expect(catalog).toContain('dsh-cc-agents:critic')
    expect(catalog).toContain('dsh-cc-agents:executor')
    expect(catalog).toContain('dsh-cc-agents:marathon')
    expect(catalog).toContain('## Available subagents')
  })
})
