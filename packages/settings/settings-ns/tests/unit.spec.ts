/**
 * Unit specs for the idempotent settings-namespace registration helpers, run
 * against fake providers through real cordis contexts (`ctx.provide`) — the
 * established package test idiom. Contract: docs/plans/2026-09-16-settings-namespace-idempotence.md §3.1.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { installSectionSafe, registerNamespaceSafe } from '../src/index.ts'

const NS = 'cc-test-ns'

/** Schemastery-shaped stand-in; the fake provider never resolves through it. */
const schema = { type: 'object' } as never

interface RecordedCall {
  op: 'register' | 'installSection'
  ns: string
  schema?: unknown
  options?: unknown
  owner?: unknown
  entry?: unknown
  hooks?: unknown
}

/** Fake provider: records register/installSection calls, throws on duplicates. */
function fakeProvider(resolved: Record<string, unknown> = { level: 1 }) {
  const registrations = new Set<string>()
  const calls: RecordedCall[] = []
  const provider = {
    calls,
    ctx: undefined as unknown as Context,
    register(ns: string, schema: unknown, options: unknown) {
      calls.push({ op: 'register', ns, schema, options })
      if (registrations.has(ns)) {
        throw new Error(`settings namespace "${ns}" is already registered`)
      }
      registrations.add(ns)
    },
    get(ns: string) {
      return registrations.has(ns) ? structuredClone(resolved) : undefined
    },
    installSection(owner: Context, ns: string, schema: unknown, entry: unknown, hooks: unknown) {
      calls.push({ op: 'installSection', ns, owner, schema, entry, hooks })
    },
    /** Simulate the owning fiber disposing: the registration disappears. */
    dropRegistration(ns: string) {
      registrations.delete(ns)
    },
  }
  return provider
}

function boot(provider: ReturnType<typeof fakeProvider>): Context {
  const ctx = new Context()
  provider.ctx = ctx
  ctx.provide('settings', provider)
  return ctx
}

describe('registerNamespaceSafe', () => {
  it('returns undefined without a settings provider and never registers (§3.1.1)', () => {
    const ctx = new Context()
    const read = registerNamespaceSafe(ctx, NS, schema)
    expect(read()).toBeUndefined()
  })

  it('registers once and reads the provider-resolved value (§3.1.2)', () => {
    const provider = fakeProvider({ level: 3 })
    const ctx = boot(provider)
    const read = registerNamespaceSafe(ctx, NS, schema)
    expect(read()).toEqual({ level: 3 })
    expect(provider.calls[0]).toMatchObject({ op: 'register', ns: NS })
  })

  it('a second module copy degrades on duplicate registration instead of throwing (§3.1.3)', async () => {
    const provider = fakeProvider({ level: 4 })
    const ctx = boot(provider)
    const readA = registerNamespaceSafe(ctx, NS, schema)
    expect(readA()).toEqual({ level: 4 })
    const { registerNamespaceSafe: registerCopy } = await import('../src/index.ts?copy2')
    const readB = registerCopy(ctx, NS, schema)
    expect(readB()).toEqual({ level: 4 })
  })

  it('self-heals: after the registration disappears, the next read re-registers (§3.1.4)', () => {
    const provider = fakeProvider({ level: 1 })
    const ctx = boot(provider)
    const read = registerNamespaceSafe(ctx, NS, schema)
    expect(read()).toEqual({ level: 1 })
    provider.dropRegistration(NS)
    const registerCalls = provider.calls.filter((call) => call.op === 'register').length
    expect(read()).toEqual({ level: 1 })
    expect(provider.calls.filter((call) => call.op === 'register').length).toBe(registerCalls + 1)
  })

  it('propagates non-duplicate register errors (§3.1.5)', () => {
    const provider = fakeProvider()
    const ctx = boot(provider)
    provider.register = () => {
      throw new Error('boom')
    }
    expect(() => registerNamespaceSafe(ctx, NS, schema)).toThrow('boom')
  })

  it('passes base and validate through to register (§3.1.6)', () => {
    const provider = fakeProvider()
    const ctx = boot(provider)
    const validate = () => {}
    registerNamespaceSafe(ctx, NS, schema, { base: { level: 9 }, validate })
    expect(provider.calls[0]!.options).toEqual({ base: { level: 9 }, validate })
  })
})

describe('installSectionSafe', () => {
  it('delegates to installSection with identical arguments on the fresh path (§3.1.7)', () => {
    const provider = fakeProvider()
    const ctx = boot(provider)
    const setSource: unknown[] = []
    const hooks = { setSource: (fn: () => unknown) => setSource.push(fn), onChange: () => {} }
    const entry = { level: 2 }
    installSectionSafe(ctx, NS, schema, entry, hooks)
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]).toMatchObject({ op: 'installSection', ns: NS, entry, hooks })
    expect((provider.calls[0]!.owner as Context) === ctx).toBe(true)
    // The fresh path owns the hook wiring — the wrapper must not touch it.
    expect(setSource).toHaveLength(0)
  })

  it('preflights an owned namespace: no installSection, live setSource, event-driven onChange (§3.1.8)', async () => {
    const provider = fakeProvider({ level: 1 })
    const ctx = boot(provider)
    provider.calls.length = 0
    provider.register(NS, schema, undefined) // the namespace is already owned
    provider.calls.length = 0
    let source: (() => unknown) | undefined
    let changes = 0
    const hooks = { setSource: (fn: () => unknown) => (source = fn), onChange: () => (changes += 1) }
    // The caller ctx is a plugin fiber so disposal can be observed.
    const fiber = ctx.plugin({ apply: (c) => installSectionSafe(c, NS, schema, { level: 9 }, hooks) })
    await fiber
    expect(provider.calls).toHaveLength(0) // no installSection call
    expect(source!()).toEqual({ level: 1 })
    expect(changes).toBe(1) // attach-time onChange
    ctx.emit('settings/updated', NS, { level: 2 }, { level: 1 }, 'user')
    expect(changes).toBe(2) // reload through the event, filtered by ns
    ctx.emit('settings/updated', 'other-ns', { level: 2 }, { level: 1 }, 'user')
    expect(changes).toBe(2) // foreign namespaces ignored
    await fiber.dispose()
    ctx.emit('settings/updated', NS, { level: 3 }, { level: 2 }, 'user')
    expect(changes).toBe(2) // the listener unwound with the mount
  })

  it('guards the preflight event listener against an unloading owner ctx', async () => {
    const provider = fakeProvider({ level: 1 })
    const ctx = boot(provider)
    provider.register(NS, schema, undefined) // the namespace is already owned
    let changes = 0
    const hooks = { setSource: () => {}, onChange: () => (changes += 1) }
    installSectionSafe(ctx, NS, schema, {}, hooks)
    // Simulate an unloading owner: the listener must go inert even if the
    // unwinding has not removed it yet.
    Object.defineProperty(ctx.fiber, 'state', { value: 5, configurable: true })
    ctx.emit('settings/updated', NS, { level: 2 }, { level: 1 }, 'user')
    expect(changes).toBe(1)
  })
})

describe('duplicate-registration message pin', () => {
  it('pins the exact harness message (upstream drift must fail loudly)', async () => {
    const { duplicateRegistrationMessage } = await import('../src/index.ts')
    expect(duplicateRegistrationMessage('cc-test-ns' as never)).toBe(
      'settings namespace "cc-test-ns" is already registered',
    )
  })
})
