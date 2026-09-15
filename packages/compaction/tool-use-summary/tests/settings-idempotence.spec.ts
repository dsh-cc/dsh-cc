/**
 * Regression pins for the settings-namespace double registration that broke
 * profile boot (observed in smoke:profile-boot after PR #77): under
 * dereferenced profile installs, the compaction-micro consumer and the TUS
 * plugin can load separate module copies of settings.ts, each with its own
 * `scopes` WeakMap — the second register() then hits the provider's
 * "already registered" guard and, before the fix, failed the whole loader
 * entry. The fix degrades to the provider's existing registration via
 * `settings.get(ns)`.
 *
 * The dual-module-instance case is reproduced faithfully by importing the
 * same source through a distinct URL query (vite treats them as separate
 * modules), each holding its own module-level WeakMap while sharing the
 * provider object.
 */
import { describe, expect, it } from 'vitest'
import { registerTusSettings, SETTINGS_NAMESPACE } from '../src/settings.ts'

/** Minimal provider double: register throws on the second call, get reads. */
function fakeProvider(resolved: Record<string, unknown> | undefined) {
  const registrations = new Set<string>()
  return {
    register(ns: string, _schema: unknown) {
      if (registrations.has(ns)) {
        throw new Error(`settings namespace "${ns}" is already registered`)
      }
      registrations.add(ns)
      return { get: () => resolved }
    },
    get(ns: string) {
      return registrations.has(ns) ? resolved : undefined
    },
  }
}

/** Minimal ctx double: registerTusSettings only touches ctx.get('settings'). */
function fakeCtx(provider: unknown) {
  return { get: (name: string) => (name === 'settings' ? provider : undefined) }
}

describe('registerTusSettings duplicate-registration degradation', () => {
  it('a second module copy degrades to the provider read instead of throwing (boot regression)', async () => {
    const provider = fakeProvider({ minResultBytes: 8192 })
    // First module instance: registers normally.
    const readA = registerTusSettings(fakeCtx(provider) as never)
    expect(readA().minResultBytes).toBe(8192)
    // Second module copy of the SAME source (own WeakMap, shared provider):
    // register() throws "already registered" — must degrade, not throw.
    const { registerTusSettings: registerCopy } = await import('../src/settings.ts?copy2')
    const readB = registerCopy(fakeCtx(provider) as never)
    expect(readB().minResultBytes).toBe(8192)
    expect(readB().enabled).toBe(true) // defaults still merge under the fallback
  })

  it('the fallback reads live through settings.get', async () => {
    let resolved: Record<string, unknown> | undefined = { timeoutMs: 1000 }
    const provider = {
      register: (ns: string) => {
        throw new Error(`settings namespace "${ns}" is already registered`)
      },
      get: () => resolved,
    }
    const read = registerTusSettings(fakeCtx(provider) as never)
    expect(read().timeoutMs).toBe(1000)
    resolved = { timeoutMs: 2000 }
    expect(read().timeoutMs).toBe(2000)
  })

  it('the fallback degrades to schema defaults once the owning fiber disposes (get returns undefined)', () => {
    const provider = {
      register: (ns: string) => {
        throw new Error(`settings namespace "${ns}" is already registered`)
      },
      get: () => undefined,
    }
    const read = registerTusSettings(fakeCtx(provider) as never)
    expect(read()).toEqual({
      enabled: true,
      topLevelOnly: true,
      minResultBytes: 4096,
      maxSummariesPerSession: 200,
      maxTokens: 256,
      timeoutMs: 5000,
      alias: 'haiku',
      excludeTools: ['structured_output'],
      retentionDays: 7,
      upgradeMicroPlaceholders: true,
    })
  })

  it('a non-duplicate register failure still propagates', () => {
    const provider = {
      register: () => {
        throw new Error('provider exploded for an unrelated reason')
      },
      get: () => undefined,
    }
    expect(() => registerTusSettings(fakeCtx(provider) as never)).toThrow(
      'provider exploded for an unrelated reason',
    )
  })

  it('SETTINGS_NAMESPACE is the kebab namespace actually registered', () => {
    expect(SETTINGS_NAMESPACE).toBe('cc-tool-use-summary')
  })
})
