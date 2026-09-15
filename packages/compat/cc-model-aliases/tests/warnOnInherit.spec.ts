/**
 * Tests for the cheap-lane inherit observability (plan §8 W5): when a BUILT-IN
 * alias is unconfigured so its route is inherited from the parent, the service
 * warns once per alias per session. Suppressed when the alias is configured,
 * when `model-aliases.warnOnInherit` is false, and for non-built-in aliases.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { MODEL_ALIASES_NAMESPACE, resolveAlias } from '@dsh-cc/model-aliases'
import { apply } from '../src/index.ts'

/** Test seam for the once-per-alias ledger (absent before W5 lands). */
beforeEach(async () => {
  const mod = (await import('../src/resolver.ts')) as { resetInheritWarned?: () => void }
  mod.resetInheritWarned?.()
})

const INHERIT_FRAGMENT = 'route inherited from parent — cheap-lane savings are zero for this session'

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
}

interface Routes {
  resolve(model: string | undefined): unknown
}

/** Boot the service and capture logger.warn calls. */
async function boot(
  config?: { modelAliases?: Record<string, unknown> },
  settingsDoc?: Record<string, unknown>,
): Promise<{ routes: Routes; warns: string[] }> {
  const ctx = new Context()
  const warns: string[] = []
  ctx.logger = { ...ctx.logger, warn: (m: string) => warns.push(m) }
  if (settingsDoc !== undefined) await ctx.plugin(MemorySettings, settingsDoc)
  apply(ctx, config ?? {})
  const routes = ctx.get('ccModelRoutes') as Routes
  expect(routes).toBeDefined()
  return { routes, warns }
}

describe('warn on inherited builtin alias (W5)', () => {
  it('warns exactly once per alias across repeated resolves', async () => {
    const { routes, warns } = await boot()
    routes.resolve('haiku')
    routes.resolve('haiku')
    routes.resolve('HAIKU')
    routes.resolveDetailed?.('haiku')
    expect(warns.filter((m) => m.includes(INHERIT_FRAGMENT))).toHaveLength(1)
    expect(warns[0]).toContain('haiku')
    // A different builtin alias gets its own single warn.
    routes.resolve('opus')
    expect(warns.filter((m) => m.includes(INHERIT_FRAGMENT))).toHaveLength(2)
  })

  it('sketch falling through to an unconfigured haiku peer warns naming sketch', async () => {
    const { routes, warns } = await boot()
    routes.resolve('sketch')
    expect(warns.some((m) => m.includes('sketch') && m.includes(INHERIT_FRAGMENT))).toBe(true)
  })

  it('does not warn when the alias is configured in settings', async () => {
    const { routes, warns } = await boot({}, { [MODEL_ALIASES_NAMESPACE]: { haiku: { provider: 'p', model: 'm' } } })
    routes.resolve('haiku')
    expect(warns).toHaveLength(0)
  })

  it('does not warn when the alias is configured in deployment config', async () => {
    const { routes, warns } = await boot({ modelAliases: { sonnet: 'm' } })
    routes.resolve('sonnet')
    expect(warns).toHaveLength(0)
  })

  it('does not warn when warnOnInherit is false in settings', async () => {
    const { routes, warns } = await boot({}, { [MODEL_ALIASES_NAMESPACE]: { warnOnInherit: false } })
    routes.resolve('haiku')
    routes.resolve('opus')
    expect(warns).toHaveLength(0)
  })

  it('resolveAlias no-service fallback honors warnOnInherit:false without double-warn', async () => {
    const ctx = new Context()
    const warns: string[] = []
    ctx.logger = { ...ctx.logger, warn: (m: string) => warns.push(m) }
    ctx.provide('settings', {
      get: (ns: string) => (ns === MODEL_ALIASES_NAMESPACE ? { warnOnInherit: false } : undefined),
    })
    expect(resolveAlias(ctx, 'haiku')).toBeUndefined()
    expect(warns).toHaveLength(0)
  })

  it('resolveAlias no-service fallback warns once for an unconfigured builtin', async () => {
    const ctx = new Context()
    const warns: string[] = []
    ctx.logger = { ...ctx.logger, warn: (m: string) => warns.push(m) }
    resolveAlias(ctx, 'haiku')
    resolveAlias(ctx, 'haiku')
    expect(warns.filter((m) => m.includes(INHERIT_FRAGMENT))).toHaveLength(1)
  })

  it('does not warn for a custom non-built-in unconfigured alias', async () => {
    const { routes, warns } = await boot()
    routes.resolve('customlane')
    expect(warns.some((m) => m.includes(INHERIT_FRAGMENT))).toBe(false)
  })
})
