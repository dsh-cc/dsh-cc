/**
 * Regression spec (plan §3.3): `apply()` twice against the same settings
 * provider — the `/clear` create-before-dispose overlap — must not throw,
 * and both mounts must publish a resolver reading the same overlay.
 */
import { describe, expect, it } from 'vitest'
import { apply, MODEL_ALIASES_NAMESPACE, SettingsAliasesSchema } from '../src/index.ts'
import type { ModelRoutes } from '../src/service.ts'

/** Minimal provider double: register throws on duplicates, get reads. */
function fakeProvider(resolved: Record<string, unknown>) {
  const registrations = new Set<string>()
  return {
    register(ns: string) {
      if (registrations.has(ns)) throw new Error(`settings namespace "${ns}" is already registered`)
      registrations.add(ns)
    },
    get(ns: string) {
      return registrations.has(ns) ? structuredClone(resolved) : undefined
    },
  }
}

/** Minimal ctx double covering everything `apply` touches. */
function fakeCtx(provider: unknown) {
  const services = new Map<string, unknown>()
  return {
    get: (name: string) => (name === 'settings' ? provider : services.get(name)),
    provide: (name: string, value: unknown) => services.set(name, value),
    on: () => () => {},
    logger: { warn: () => {} },
    routes: () => services.get('ccModelRoutes') as ModelRoutes,
  }
}

describe('apply duplicate-registration tolerance', () => {
  it('applies twice against the same provider without throwing; both resolvers agree', () => {
    const provider = fakeProvider({ opus: { provider: 'p', model: 'm' } })
    const a = fakeCtx(provider)
    const b = fakeCtx(provider)
    apply(a as never, {})
    apply(b as never, {})
    expect(a.routes().resolve('opus')).toEqual({ provider: 'p', model: 'm' })
    expect(b.routes().resolve('opus')).toEqual({ provider: 'p', model: 'm' })
  })

  it('a second module copy of the helper degrades on duplicate registration', async () => {
    const provider = fakeProvider({ opus: { provider: 'p', model: 'm' } })
    const { registerNamespaceSafe } = await import('@dsh-cc/settings-ns/src/index.ts?copy2')
    expect(() => registerNamespaceSafe(fakeCtx(provider) as never, MODEL_ALIASES_NAMESPACE, SettingsAliasesSchema)).not.toThrow()
  })

  it('without a settings provider the resolver still serves config defaults', () => {
    const ctx = fakeCtx(undefined)
    apply(ctx as never, { modelAliases: { opus: { provider: 'p', model: 'm' } } })
    expect(ctx.routes().resolve('opus')).toEqual({ provider: 'p', model: 'm' })
  })
})
