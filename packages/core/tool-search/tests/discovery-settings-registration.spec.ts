/**
 * The `cc-tool-discovery` registration seam (design
 * `docs/plans/2026-11-02-systemone-05-tool-discovery.md` § "Settings"): the
 * namespace is registered through `registerNamespaceSafe` against a REAL
 * `SettingsProvider`, resolves the kebab-case user section into the camelCase
 * settings, never throws across an absent settings plane, and is never a
 * boot-time hard dependency — a consumer mounted BEFORE the provider re-resolves
 * the section once the provider arrives.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@dsh-cc/settings'
import type { SettingsNamespace } from '@dsh-cc/settings'
import {
  DEFAULT_DISCOVERY_SETTINGS,
  SETTINGS_NAMESPACE,
  registerDiscoverySettings,
} from '../src/discovery-settings.ts'
import type { DiscoverySettingsReader } from '../src/discovery-settings.ts'

/** In-memory provider: the smallest real `SettingsProvider` subclass. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: ConstructorParameters<typeof SettingsProvider>[0], options?: { doc?: Record<string, unknown> }) {
    super(ctx, 'settings')
    this.doc = structuredClone(options?.doc ?? {})
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
  }

  get writable(): boolean {
    return true
  }
}

/** A plugin body that registers the namespace and exposes the resulting reader. */
function registerPlugin(store: { reader?: DiscoverySettingsReader }) {
  return {
    apply: (ctx: Context) => {
      store.reader = registerDiscoverySettings(ctx)
    },
  }
}

/** Boot a root context; the provider is mounted only when `doc` is given. */
async function harness(doc?: Record<string, unknown>) {
  const ctx = new Context()
  if (doc !== undefined) await ctx.plugin(MemorySettings, { doc })
  return ctx
}

describe('cc-tool-discovery registration', () => {
  it('resolves an absent section to the design defaults (mode off)', async () => {
    const ctx = await harness({})
    const store: { reader?: DiscoverySettingsReader } = {}
    await ctx.plugin(registerPlugin(store))
    expect(store.reader?.()).toEqual(DEFAULT_DISCOVERY_SETTINGS)
  })

  it('resolves a kebab-case user section into the camelCase settings', async () => {
    const ctx = await harness({
      [SETTINGS_NAMESPACE]: { mode: 'shadow', 'timeout-ms': 900, 'batch-size': 4, 'min-direct-fit': 0.5 },
    })
    const store: { reader?: DiscoverySettingsReader } = {}
    await ctx.plugin(registerPlugin(store))
    expect(store.reader?.()).toEqual({
      ...DEFAULT_DISCOVERY_SETTINGS,
      mode: 'shadow',
      timeoutMs: 900,
      batchSize: 4,
      minDirectFit: 0.5,
    })
  })

  it('keeps an out-of-range stored value from reaching a judgment', async () => {
    // The schema rejects the malformed layer at publish; the resolved value
    // stays the schema defaults, so the reader stays valid with `mode: off`.
    const ctx = await harness({ [SETTINGS_NAMESPACE]: { 'timeout-ms': 3 } })
    const store: { reader?: DiscoverySettingsReader } = {}
    await ctx.plugin(registerPlugin(store))
    expect(store.reader?.()).toEqual(DEFAULT_DISCOVERY_SETTINGS)
  })

  it('never hard-depends on the settings plane: a later provider is picked up', async () => {
    const ctx = await harness()
    const store: { reader?: DiscoverySettingsReader } = {}
    await ctx.plugin(registerPlugin(store))
    // Without a provider the namespace reads as absent (defaults, feature off).
    expect(store.reader?.()).toEqual(DEFAULT_DISCOVERY_SETTINGS)

    // The provider arrives afterwards: the deferred registration resolves it.
    await ctx.plugin(MemorySettings, { doc: { [SETTINGS_NAMESPACE]: { mode: 'active' } } })
    expect(store.reader?.().mode).toBe('active')
  })
})
