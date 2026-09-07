/**
 * Integration tests for cc-shell model-alias provisioning: the CC plugin
 * (mountCcPlugin) source path threads the spawn-time resolver into plugin-
 * shipped agents. The resolver comes from the `ccModelRoutes` routes service
 * (`@dsh-cc/model-aliases`), whose config `modelAliases` resolve as
 * routes, a live settings overlay overrides config, and a settings `null`
 * deleting a config alias falls back to the builtin behavior (inherit). With
 * no routes service mounted the resolver's trampoline degrades to `undefined`
 * (inherit). Covers the review finding M1 path.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SettingsCascadeProvider } from '@dsh-cc/settings-cascade'
import { apply as applyModelRoutes } from '@dsh-cc/model-aliases'
import type { AliasTarget } from '@dsh-cc/model-aliases'
import { apply, type Config } from '../src/index.ts'

interface FakeBackend {
  last: unknown
  start(request: unknown): Promise<unknown>
}

interface ProviderRecord {
  name: string
  start(request: unknown): Promise<unknown>
}

/** A subagents seam that captures plugin-shipped agent providers. */
function makeSubagentsSeam(): { seam: { registerProvider: (p: unknown) => () => void; getProvider: () => unknown }; providers: ProviderRecord[]; backend: FakeBackend } {
  const backend: FakeBackend = {
    last: undefined,
    start: async (request) => { backend.last = request; return { forwarded: request } },
  }
  const providers: ProviderRecord[] = []
  return {
    backend,
    providers,
    seam: {
      registerProvider: (p) => { providers.push(p as never); return () => {} },
      getProvider: () => backend,
    },
  }
}

/**
 * Boot the routes service (model-aliases), an optional settings provider
 * backing the `model-aliases` overlay, and cc-shell glue over this context.
 * When `mountRoutes` is false the routes service is left out, exercising the
 * glue resolver's unmounted trampoline path.
 */
async function bootWith({
  userDoc,
  config,
  routes,
  mountRoutes = true,
  subagents,
}: {
  userDoc: Record<string, unknown> | undefined
  config: Config
  routes?: { modelAliases?: Record<string, AliasTarget> }
  mountRoutes?: boolean
  subagents: { registerProvider: (p: unknown) => () => void; getProvider: () => unknown }
}): Promise<Context> {
  const settingsDir = tempDir('settings')
  const userPath = join(settingsDir, 'user.json')
  if (userDoc !== undefined) writeFileSync(userPath, JSON.stringify(userDoc))
  const ctx = new Context()
  ctx.provide('subagents', subagents)
  await ctx.plugin(SettingsCascadeProvider, { userSettingsPath: userPath })
  if (mountRoutes) applyModelRoutes(ctx, routes ?? {})
  await apply(ctx, config)
  return ctx
}

let tmp: string
let cleanupDirs: string[]

beforeEach(() => {
  cleanupDirs = []
  tmp = mkdtempSync(join(tmpdir(), 'cc-shell-aliases-'))
  cleanupDirs.push(tmp)
})

afterEach(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(...parts: string[]): string {
  const dir = join(tmp, ...parts)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Write a CC plugin root with one agent file. */
function writeAgentPlugin(root: string, model: string): void {
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, 'agents'), { recursive: true })
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'typed', version: '0.1.0' }, null, 2))
  writeFileSync(join(root, 'agents', 'doc.md'),
    `---\ndescription: doc agent\nmodel: ${JSON.stringify(model)}\n---\nDoc contents.`, 'utf8')
}

describe('cc-shell model alias provisioning', () => {
  it('mounts a plugin-shipped agent and resolves its model via config aliases (M1 path)', async () => {
    const discovery = tempDir('discovery')
    writeAgentPlugin(join(discovery, 'typed'), 'opus')
    const { seam, providers, backend } = makeSubagentsSeam()
    const ctx = await bootWith({
      userDoc: undefined,
      subagents: seam,
      routes: { modelAliases: { opus: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } },
      config: { pluginDirs: [discovery] },
    })

    expect(providers).toHaveLength(1)
    expect(providers[0]!.name).toBe('typed:doc')
    await providers[0]!.start({ agentOptions: { provider: 'parent' } })
    expect(backend.last).toMatchObject({ agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } })
    expect(ctx.ccPlugins.list()).toHaveLength(1)
  })

  it('a settings overlay overrides a config-default alias', async () => {
    const discovery = tempDir('discovery')
    writeAgentPlugin(join(discovery, 'typed'), 'sonnet')
    const { seam, providers, backend } = makeSubagentsSeam()
    const ctx = await bootWith({
      userDoc: { 'model-aliases': { sonnet: { provider: 'anthropic', model: 'claude-sonnet' } } },
      subagents: seam,
      routes: { modelAliases: { sonnet: 'cfg-value' } },
      config: { pluginDirs: [discovery] },
    })

    expect(providers).toHaveLength(1)
    await providers[0]!.start({ agentOptions: { provider: 'parent' } })
    expect(backend.last).toMatchObject({ agentOptions: { provider: 'anthropic', model: 'claude-sonnet' } })
    void ctx
  })

  it('a settings null deleting a config builtin alias falls back to inherit (no override)', async () => {
    const discovery = tempDir('discovery')
    writeAgentPlugin(join(discovery, 'typed'), 'opus')
    const { seam, providers, backend } = makeSubagentsSeam()
    const ctx = await bootWith({
      userDoc: { 'model-aliases': { opus: null } },
      subagents: seam,
      routes: { modelAliases: { opus: { provider: 'cfg', model: 'cfg-model' } } },
      config: { pluginDirs: [discovery] },
    })

    expect(providers).toHaveLength(1)
    await providers[0]!.start({ agentOptions: { provider: 'parent' } })
    // Deleted from config, unconfigured builtin → inherit parent route exactly.
    expect(backend.last).toMatchObject({ agentOptions: { provider: 'parent' } })
    void ctx
  })

  it('with no routes service mounted, a plugin agent model resolves to inherit (no override)', async () => {
    const discovery = tempDir('discovery')
    writeAgentPlugin(join(discovery, 'typed'), 'opus')
    const { seam, providers, backend } = makeSubagentsSeam()
    const ctx = await bootWith({
      userDoc: undefined,
      subagents: seam,
      mountRoutes: false,
      config: { pluginDirs: [discovery] },
    })

    // The routes service was never mounted, so `ccModelRoutes` is absent and
    // the glue's resolver trampoline returns undefined → no model/provider
    // override; the agent inherits the parent route unchanged.
    expect(ctx.get('ccModelRoutes')).toBeUndefined()
    expect(providers).toHaveLength(1)
    await providers[0]!.start({ agentOptions: { provider: 'parent' } })
    expect(backend.last).toMatchObject({ agentOptions: { provider: 'parent' } })
    void ctx
  })

  it('mounts without property-accessing ctx.settings (cordis inject enforcement)', async () => {
    // Regression for the production mount failure "cannot get property
    // \"settings\" without inject": the loader-scoped context proxy in a real
    // boot throws on property access for any service the entry does not inject
    // (the glue injects nothing), while direct `apply()` over a root Context
    // never enforces it — letting `ctx.settings?.…` ship. Guard the contract:
    // a property read of `settings` fails here; only `ctx.get('settings')` is
    // allowed.
    const settingsDir = tempDir('settings')
    const userPath = join(settingsDir, 'user.json')
    const { seam, providers } = makeSubagentsSeam()
    const real = new Context()
    real.provide('subagents', seam)
    await real.plugin(SettingsCascadeProvider, { userSettingsPath: userPath })
    const guarded = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'settings') {
          throw new Error('cannot get property "settings" without inject')
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    await apply(guarded, { pluginDirs: [tempDir('empty-discovery')] })
    expect(providers).toHaveLength(0)
  })
})
