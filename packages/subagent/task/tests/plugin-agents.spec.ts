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
import { join } from 'node:path'
import { AgentProvider } from '@dsh-cc/plugin-loader'
import { loadAgentsDir } from '@dsh-cc/claude-code-agents'
import type { AgentDefinition } from '@dsh-cc/claude-code-agents'
import { PluginAgentIndex } from '../src/plugin-agents.ts'

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
