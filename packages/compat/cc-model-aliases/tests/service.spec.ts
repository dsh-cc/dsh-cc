/**
 * Tests for the `ccModelRoutes` service: the plugin entry that owns the
 * `model-aliases` settings namespace registration and exposes a spawn-time
 * resolver over it. The service degrades to config-only aliases when no
 * settings provider is mounted, and re-reads the live scope on every resolve.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@dsh-cc/settings-provider'
import { apply } from '../src/index.ts'
import type { AliasTarget, ResolvedRoute } from '../src/types.ts'

/** Minimal in-memory settings provider over one raw document. */
class MemorySettings extends SettingsProvider {
  private doc: Record<string, unknown>
  constructor(ctx: Context, doc: Record<string, unknown>) {
    super(ctx)
    this.doc = doc
  }
  readonly writable = false
  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(this.doc)
  }
  protected persist(): Promise<void> {
    return Promise.resolve()
  }
  /** Test seam: publish a fresh document (the watcher-equivalent path). */
  republish(next: Record<string, unknown>): void {
    this.doc = next
    ;(this as unknown as { publish(doc: Record<string, unknown>): void }).publish(next)
  }
}

interface Routes {
  resolve(model: string | undefined): ResolvedRoute | undefined
  inspect(model: string | undefined): { kind: string; via?: string; hop?: string; route?: ResolvedRoute }
}

async function boot(
  config?: { modelAliases?: Record<string, AliasTarget> },
  settingsDoc?: Record<string, unknown>,
): Promise<{ ctx: Context; routes: Routes }> {
  const ctx = new Context()
  if (settingsDoc !== undefined) {
    await ctx.plugin(MemorySettings, settingsDoc)
  }
  apply(ctx, config ?? {})
  const routes = ctx.get('ccModelRoutes') as Routes | undefined
  expect(routes).toBeDefined()
  return { ctx, routes: routes as Routes }
}

describe('ccModelRoutes service', () => {
  it('publishes BOTH resolve and resolveDetailed (the Task resume-pin capture path)', async () => {
    const { routes } = await boot({ modelAliases: { opus: { provider: 'p', model: 'm' } } })
    // Regression: the service object once lacked `resolveDetailed`, so every
    // captured background spawn (Task tool resume-pin capture) threw TypeError.
    expect(typeof routes.resolve).toBe('function')
    expect(typeof routes.resolveDetailed).toBe('function')
    expect(routes.resolve('opus')).toEqual({ provider: 'p', model: 'm' })
    expect(routes.resolveDetailed('opus')).toEqual({
      selector: 'opus',
      via: 'alias',
      route: { provider: 'p', model: 'm' },
    })
  })

  it('provides a resolver that maps a config alias to a route', async () => {
    const { routes } = await boot({ modelAliases: { opus: { provider: 'p', model: 'm' } } })
    expect(routes.resolve('opus')).toEqual({ provider: 'p', model: 'm' })
  })

  it('unconfigured builtin aliases inherit the parent route', async () => {
    const { routes } = await boot({})
    expect(routes.resolve('sonnet')).toBeUndefined()
    expect(routes.resolve('inherit')).toBeUndefined()
    expect(routes.resolve(undefined)).toBeUndefined()
  })

  it('reads the settings overlay live on every resolve', async () => {
    const { ctx, routes } = await boot({ modelAliases: { sonnet: 'flash-cfg' } }, { 'model-aliases': { sonnet: 'flash-a' } })
    expect(routes.resolve('sonnet')).toEqual({ model: 'flash-a' })
    // Simulate a settings write-back: the resolver must observe the new value
    // without re-registering anything.
    ;(ctx.get('settings') as MemorySettings).republish({ 'model-aliases': { sonnet: 'flash-b' } })
    expect(routes.resolve('sonnet')).toEqual({ model: 'flash-b' })
  })

  it('a settings null deletes the config alias and falls to inherit', async () => {
    const { routes } = await boot(
      { modelAliases: { opus: { provider: 'p', model: 'm' } } },
      { 'model-aliases': { opus: null } },
    )
    expect(routes.resolve('opus')).toBeUndefined()
  })

  it('works without any settings provider (config-only + builtin fallback)', async () => {
    const { routes } = await boot({ modelAliases: { fable: 'kimi' } })
    expect(routes.resolve('fable')).toEqual({ model: 'kimi' })
    expect(routes.resolve('haiku')).toBeUndefined()
  })

  it('object form may omit provider and still stamp effort', async () => {
    const { routes } = await boot({
      modelAliases: { sonnet: { model: 'glm-5.3-flash', reasoningEffort: 'max' } },
    })
    expect(routes.resolve('sonnet')).toEqual({ model: 'glm-5.3-flash', reasoningEffort: 'max' })
  })

  it('exposes inspect with provenance alongside resolve', async () => {
    const { routes } = await boot({ modelAliases: { opus: { provider: 'p', model: 'm' } } })
    expect(typeof routes.inspect).toBe('function')
    const inspection = routes.inspect('opus')
    expect(inspection.kind).toBe('route')
    expect(inspection.via).toBe('configured')
    expect(inspection.route).toEqual(routes.resolve('opus'))
  })
})
