/**
 * Tests for the PluginAgentIndex: live enumeration of plugin agent providers
 * from the `subagents` seam, the brand + structural guard (loader brand, plus
 * function `start`, colon scoped id, definition shape), exact-match resolve,
 * and the lazy seam read (plugin mounts are effect-scoped and may appear
 * after `apply()`).
 *
 * Provider fixtures combine hand-built fakes (the tool.spec.ts fake-seam
 * pattern) with REAL `AgentProvider` instances from `@dsh-cc/plugin-loader`,
 * built the way `mountAgents` builds them for a tmp plugin root (scoped
 * `registeredName`, bare `definition.agentType`).
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentProvider, mountCcPlugin } from '@dsh-cc/plugin-loader'
import { loadAgentsDir } from '@dsh-cc/claude-code-agents'
import type { AgentDefinition } from '@dsh-cc/claude-code-agents'
import { PluginAgentIndex } from '../src/plugin-agents.ts'
import { registerTaskTool, TASK_TOOL } from '../src/tool.ts'
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

/** A mutable fake subagents seam (the tool.spec.ts makeSeam pattern, minus start). */
function fakeSeam(): {
  seam: { list(): string[]; getProvider(name: string): unknown }
  register(provider: unknown): void
  unregister(provider: unknown): void
} {
  const byName = new Map<string, unknown>()
  return {
    seam: {
      list: () => [...byName.keys()],
      getProvider: (name: string) => byName.get(name),
    },
    register(provider) {
      byName.set((provider as { name: string }).name, provider)
    },
    unregister(provider) {
      byName.delete((provider as { name: string }).name)
    },
  }
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

/** A builtin-style provider: no definition (spawn/fork shape). */
function builtinProvider(name: string): unknown {
  return {
    name,
    start: async () => ({ result: Promise.resolve({ stopReason: 'completed' }) }),
  }
}

describe('PluginAgentIndex', () => {
  it('lists real AgentProvider instances with scoped ids and their definitions', async () => {
    const root = tempPluginRoot()
    mkdirSync(join(root, 'agents'), { recursive: true })
    writeFileSync(
      join(root, 'agents', 'researcher.md'),
      '---\ndescription: researcher agent\n---\nYou are the researcher.',
      'utf8',
    )
    const defs = await loadAgentsDir(join(root, 'agents'), 'project')
    expect(defs).toHaveLength(1)
    const { seam, register } = fakeSeam()
    // Exactly how mountAgents registers under a namespacePrefix.
    for (const def of defs) {
      register(new AgentProvider(def, () => undefined, undefined, `p:${def.agentType}`))
    }
    const index = new PluginAgentIndex({ get: () => seam })
    expect(index.list()).toEqual([
      { id: 'p:researcher', definition: defs[0] },
    ])
    expect(index.resolve('p:researcher')).toBe(defs[0])
    expect(index.resolve('researcher')).toBeUndefined()
    expect(index.resolve('p:nope')).toBeUndefined()
    expect(index.knownIds()).toEqual(['p:researcher'])
  })

  it('excludes builtin providers without a colon-scoped name or definition', () => {
    const { seam, register } = fakeSeam()
    register(builtinProvider('spawn'))
    register(builtinProvider('fork'))
    const index = new PluginAgentIndex({ get: () => seam })
    expect(index.list()).toEqual([])
    expect(index.knownIds()).toEqual([])
  })

  it('excludes a brandless provider even when it is definition-shaped (§9.4 brand guard)', () => {
    const { seam, register } = fakeSeam()
    // Shape-faked provider: start fn + colon name + definition-shaped property,
    // but never created by the loader (no PLUGIN_AGENT_PROVIDER_BRAND).
    register({
      name: 'p:fake',
      start: async () => ({}),
      definition: { agentType: 'fake', systemPrompt: 'You are fake.', whenToUse: 'fake' },
    })
    const index = new PluginAgentIndex({ get: () => seam })
    expect(index.list()).toEqual([])
    expect(index.resolve('p:fake')).toBeUndefined()
  })

  it('applies the structural guard: start + colon name + definition shape', () => {
    const { seam, register } = fakeSeam()
    // Colon name but no definition → excluded.
    register({ name: 'p:bare', start: async () => ({}) })
    // Definition-shaped but no start function → excluded.
    register({ name: 'p:nostart', definition: { agentType: 'x', systemPrompt: 's' } })
    // Definition without a string agentType/systemPrompt → excluded.
    register({ name: 'p:bad', start: async () => ({}), definition: { agentType: 1 } })
    // Bare name (no namespacePrefix at mount) → excluded.
    register(new AgentProvider(pluginDef('bare'), () => undefined))
    const index = new PluginAgentIndex({ get: () => seam })
    expect(index.list()).toEqual([])
  })

  it('reads the seam lazily: providers registered after index construction are seen', () => {
    // The index is created BEFORE any provider registers (seam empty at
    // construction; get() re-invoked on every call).
    let seam: { list(): string[]; getProvider(name: string): unknown } = { list: () => [], getProvider: () => undefined }
    const index = new PluginAgentIndex({ get: () => seam })
    expect(index.list()).toEqual([])
    const { seam: real, register } = fakeSeam()
    register(new AgentProvider(pluginDef('researcher'), () => undefined, undefined, 'p:researcher'))
    seam = real
    expect(index.list()).toHaveLength(1)
    expect(index.resolve('p:researcher')).toBeDefined()
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
   * plus the registerProvider/getProvider/list surface `mountAgents` and
   * `PluginAgentIndex` read. `startContinuable` mirrors the harness: it emits
   * `subagent/start`, records the folded request, and settles the epoch.
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
      async start(name: string, request: Record<string, unknown>) {
        const provider = providers.get(name) as { start(r: unknown): Promise<unknown> } | undefined
        if (provider === undefined) throw new Error(`unknown provider "${name}"`)
        return provider.start(request)
      },
      async startContinuable(spec: Record<string, unknown>) {
        const childId = (spec['childId'] as string | undefined) ?? `child-${continuable.length + 1}`
        const runId = `run-${continuable.length + 1}`
        emit('subagent/start', { runId, provider: spec['provider'], id: childId, local: true })
        continuable.push(spec['request'] as Record<string, unknown>)
        void (async () => {
          emit('subagent/end', {
            runId, provider: spec['provider'], id: childId, local: true,
            stopReason: 'completed',
            lastAssistantMessage: [{ type: 'text', text: 'REASONED OUTPUT' }],
          })
        })()
        return { childId, messageId: 'm-1' }
      },
      getProvider: (name: string) => providers.get(name),
      list: () => [...providers.keys()],
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

  it('dispatches dsh-cc-agents:deep-reasoner foreground: persona folds, collected text returns', async () => {
    const { continuable, workspace, taskDef } = await setup()
    const result = await taskDef.execute(
      { subagent_type: 'dsh-cc-agents:deep-reasoner', description: 'reason', prompt: 'think hard', run_in_background: false },
      { agent: agentAt(workspace), signal: new AbortController().signal, token: 'tok-1' },
    )
    expect(result.status).toBe('completed')
    expect(result.text).toBe('REASONED OUTPUT')

    expect(continuable).toHaveLength(1)
    const request = continuable[0]!
    // The persona folds into the spawn request.
    expect(String(request['persona'])).toContain('Staff Engineer')
    // No routes service: the opus alias is unconfigured → no agentOptions.
    expect(request['agentOptions']).toBeUndefined()
    // The shipped tools list sanitizes untouched against the built-in set.
    expect(request['toolFilter']).toBeDefined()
  })

  it('the catalog lists both scoped ids', async () => {
    const { ctx } = await setup()
    const index = new PluginAgentIndex(ctx)
    expect(index.knownIds().sort()).toEqual([
      'dsh-cc-agents:deep-reasoner',
      'dsh-cc-agents:fast-worker',
    ])
    const catalog = renderCatalog(
      index.list().map(entry => ({
        agentType: entry.id,
        whenToUse: entry.definition.whenToUse,
      }) as AgentDefinition),
    )
    expect(catalog).toContain('dsh-cc-agents:deep-reasoner')
    expect(catalog).toContain('dsh-cc-agents:fast-worker')
    expect(catalog).toContain('## Available subagents')
  })
})
