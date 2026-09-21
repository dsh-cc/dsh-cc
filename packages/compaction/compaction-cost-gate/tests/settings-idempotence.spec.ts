/**
 * Regression spec (PR #82 shape): registering the `cc-compaction-cost-gate`
 * namespace twice against the same settings provider — the `/clear`
 * create-before-dispose overlap window — must not throw, and both readers
 * must observe the same resolved value.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_SETTINGS, registerCostGateSettings, SETTINGS_NAMESPACE } from '../src/settings.ts'

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
  return { get: (name: string) => (name === 'settings' ? provider : undefined) } as unknown as Context
}

describe('cc-compaction-cost-gate settings registration', () => {
  it('registers twice against the same provider without throwing; both readers agree', () => {
    const provider = fakeProvider({ enabled: true, mode: 'on' })
    const readA = registerCostGateSettings(fakeCtx(provider))
    const readB = registerCostGateSettings(fakeCtx(provider))
    expect(readA().enabled).toBe(true)
    expect(readB().mode).toBe('on')
  })

  it('maps hyphenated settings keys onto the resolved shape', () => {
    const provider = fakeProvider({
      enabled: true,
      'cooldown-ms': 5,
      'window-pressure-tokens': 90_000,
      'model-table': [{ model: 'm', inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 1, cacheWritePerMTok: 2 }],
    })
    const read = registerCostGateSettings(fakeCtx(provider))
    const settings = read()
    expect(settings.cooldownMs).toBe(5)
    expect(settings.windowPressureTokens).toBe(90_000)
    expect(settings.modelTable?.[0]?.cacheWritePerMTok).toBe(2)
  })

  it('without a settings provider the reader yields the shipped-dark defaults', () => {
    const read = registerCostGateSettings(fakeCtx(undefined))
    expect(read()).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.enabled).toBe(false)
    expect(DEFAULT_SETTINGS.mode).toBe('dry-run')
  })
})
