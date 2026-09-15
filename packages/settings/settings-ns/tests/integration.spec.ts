/**
 * Real-cordis integration specs for the settings-ns helpers (plan §3.2): real
 * cordis contexts, a real in-memory `SettingsProvider` subclass, and real
 * plugin mounts (`ctx.plugin`) so fiber disposal is exercised — fake providers
 * cannot see fiber binding or context shadowing (critic M4).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { installSectionSafe, registerNamespaceSafe, type SettingsReader } from '../src/index.ts'

const NS = 'cc-settings-ns-it'
const Schema: z<{ level: number }> = z.object({ level: z.number().default(1) })

/** In-memory provider: the smallest real `SettingsProvider` subclass. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: ConstructorParameters<typeof SettingsProvider>[0], options?: { doc?: Record<string, unknown> }) {
    super(ctx)
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

/** A plugin body that registers NS and exposes the resulting reader. */
function registerPlugin(module: { registerNamespaceSafe: typeof registerNamespaceSafe }, store: { reader?: SettingsReader<{ level: number }> }) {
  return { apply: (ctx: Context) => (store.reader = module.registerNamespaceSafe(ctx, NS, Schema)) }
}

/** A plugin body that attaches to NS through `installSectionSafe`. */
function sectionPlugin(module: { installSectionSafe: typeof installSectionSafe }, entry: { level: number }, hooks: { setSource: (fn: () => { level: number }) => void; onChange: () => void }) {
  return { apply: (ctx: Context) => installSectionSafe(ctx, NS, Schema, entry, hooks) }
}

/** Boot a root context with the in-memory provider holding one user section. */
async function harness(doc: Record<string, unknown> = { [NS]: { level: 5 } }) {
  const ctx = new Context()
  const fiber = ctx.plugin(MemorySettings, { doc })
  await fiber
  return ctx
}

describe('registerNamespaceSafe under real cordis', () => {
  it('double mount over a shared provider: the second mount does not throw and both readers agree (§3.2.1)', async () => {
    const ctx = await harness()
    const { registerNamespaceSafe: registerCopy } = await import('../src/index.ts?copy2')
    const a: { reader?: SettingsReader<{ level: number }> } = {}
    const b: { reader?: SettingsReader<{ level: number }> } = {}
    const fiberA = ctx.plugin(registerPlugin({ registerNamespaceSafe }, a))
    await fiberA
    const fiberB = ctx.plugin(registerPlugin({ registerNamespaceSafe: registerCopy }, b))
    await fiberB
    expect(a.reader!()).toEqual({ level: 5 })
    expect(b.reader!()).toEqual({ level: 5 })
  })

  it('owner disposal, live survivor: the survivor re-acquires the user-layer value on the next read (§3.2.2)', async () => {
    const ctx = await harness()
    const { registerNamespaceSafe: registerCopy } = await import('../src/index.ts?copy2')
    const a: { reader?: SettingsReader<{ level: number }> } = {}
    const b: { reader?: SettingsReader<{ level: number }> } = {}
    const fiberA = ctx.plugin(registerPlugin({ registerNamespaceSafe }, a))
    await fiberA
    const fiberB = ctx.plugin(registerPlugin({ registerNamespaceSafe: registerCopy }, b))
    await fiberB
    await fiberA.dispose()
    // Schema default would be { level: 1 }; the re-acquired value is the user layer.
    expect(b.reader!()).toEqual({ level: 5 })
    expect(b.reader!()).toEqual({ level: 5 }) // stable across reads
  })

  it('a stale reader from the disposed mount degrades to undefined and never throws (§3.2.3)', async () => {
    const ctx = await harness()
    const a: { reader?: SettingsReader<{ level: number }> } = {}
    const fiberA = ctx.plugin(registerPlugin({ registerNamespaceSafe }, a))
    await fiberA
    const stale = a.reader!
    await fiberA.dispose()
    expect(stale()).toBeUndefined()
    expect(stale()).toBeUndefined()
  })
})

describe('installSectionSafe under real cordis (§3.2.4)', () => {
  it('a second mount falls to the event-wired path and still reloads on a settings write', async () => {
    const ctx = await harness()
    const { installSectionSafe: installSectionCopy } = await import('../src/index.ts?copy2')
    const first: { source?: () => { level: number }; changes: number } = { changes: 0 }
    const second: { source?: () => { level: number }; changes: number } = { changes: 0 }
    const hooksA = {
      setSource: (fn: () => { level: number }) => (first.source = fn),
      onChange: () => (first.changes += 1),
    }
    const hooksB = {
      setSource: (fn: () => { level: number }) => (second.source = fn),
      onChange: () => (second.changes += 1),
    }
    const fiberA = ctx.plugin(sectionPlugin({ installSectionSafe }, { level: 1 }, hooksA))
    await fiberA
    const fiberB = ctx.plugin(sectionPlugin({ installSectionSafe: installSectionCopy }, { level: 9 }, hooksB))
    await fiberB
    // First mount took the fresh path (attach-time onChange through installSection).
    expect(first.changes).toBe(1)
    // Second mount took the preflight path: live source getter + attach onChange.
    expect(second.source!()).toEqual({ level: 5 })
    expect(second.changes).toBe(1)
    // A settings write reloads both consumers.
    await (ctx.get('settings') as MemorySettings).update(NS, { level: 7 })
    expect(second.changes).toBe(2)
    expect(second.source!()).toEqual({ level: 7 })
    expect(first.changes).toBe(2)
    expect(first.source!()).toEqual({ level: 7 })

    // The preflight listener unwinds with its mount.
    await fiberB.dispose()
    await (ctx.get('settings') as MemorySettings).update(NS, { level: 8 })
    expect(second.changes).toBe(2)
    expect(first.changes).toBe(3)
  })
})
