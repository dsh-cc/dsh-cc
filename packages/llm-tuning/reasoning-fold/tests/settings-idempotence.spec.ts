/**
 * Regression spec (plan §3.3): `registerProbeSetting` twice against the same
 * settings provider — the `/clear` overlap — must not throw, and both probe
 * readers must observe the same value.
 */
import { describe, expect, it } from 'vitest'
import { registerProbeSetting, SETTINGS_NAMESPACE, SettingsSchema } from '../src/settings.ts'

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

/** Minimal ctx double: only ctx.get('settings') is consulted. */
function fakeCtx(provider: unknown) {
  return { get: (name: string) => (name === 'settings' ? provider : undefined) }
}

describe('registerProbeSetting duplicate-registration tolerance', () => {
  it('registers twice against the same provider without throwing; both readers agree', () => {
    const provider = fakeProvider({ probe: false })
    const readA = registerProbeSetting(fakeCtx(provider) as never)
    const readB = registerProbeSetting(fakeCtx(provider) as never)
    expect(readA?.()).toBe(false)
    expect(readB?.()).toBe(false)
  })

  it('a second module copy of the helper degrades on duplicate registration', async () => {
    const provider = fakeProvider({ probe: false })
    const { registerNamespaceSafe } = await import('@dsh-cc/settings-ns/src/index.ts?copy2')
    expect(() => registerNamespaceSafe(fakeCtx(provider) as never, SETTINGS_NAMESPACE, SettingsSchema)).not.toThrow()
  })

  it('without a settings provider the plugin registers nothing (undefined reader)', () => {
    expect(registerProbeSetting(fakeCtx(undefined) as never)).toBeUndefined()
  })
})
