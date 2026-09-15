/**
 * Regression spec (plan §3.3): `registerSettings` twice against the same
 * settings provider — the `/clear` overlap — must not throw, and both
 * readers must observe the same (defaults-merged) value.
 */
import { describe, expect, it } from 'vitest'
import { registerSettings, SETTINGS_NAMESPACE, SettingsSchema } from '../src/settings.ts'

/** Minimal provider double: register throws on duplicates, get reads. */
function fakeProvider(resolved: Record<string, unknown> | undefined) {
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

describe('registerSettings duplicate-registration tolerance', () => {
  it('registers twice against the same provider without throwing; both readers agree', () => {
    const provider = fakeProvider({ enabled: true, timeoutMs: 777 })
    const readA = registerSettings(fakeCtx(provider) as never)
    const readB = registerSettings(fakeCtx(provider) as never)
    expect(readA()).toEqual({ enabled: true, alias: 'haiku', timeoutMs: 777, maxTokens: 128 })
    expect(readB()).toEqual({ enabled: true, alias: 'haiku', timeoutMs: 777, maxTokens: 128 })
  })

  it('a second module copy of the helper degrades on duplicate registration', async () => {
    const provider = fakeProvider({ enabled: true })
    const { registerNamespaceSafe } = await import('@dsh-cc/settings-ns/src/index.ts?copy2')
    expect(() => registerNamespaceSafe(fakeCtx(provider) as never, SETTINGS_NAMESPACE, SettingsSchema)).not.toThrow()
  })

  it('without a settings provider the plugin registers nothing (undefined reader)', () => {
    expect(registerSettings(fakeCtx(undefined) as never)).toBeUndefined()
  })
})
