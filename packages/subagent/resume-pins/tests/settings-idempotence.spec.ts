/**
 * Regression spec (plan §3.3): the resume-pins plugin registers the
 * `subagents-resume` policy namespace on every mount; mounting TWICE against
 * the same settings provider — the `/clear` overlap — must not throw.
 */
import { describe, expect, it } from 'vitest'
import { apply, RESUME_PIN_STORE, ResumePolicySchema } from '../src/plugin.ts'
import { RESUME_POLICY_NAMESPACE } from '../src/policy.ts'

/** Minimal provider double: register throws on duplicates, get reads. */
function fakeProvider(resolved: Record<string, unknown> | undefined) {
  const registrations = new Set<string>()
  return {
    registered: registrations,
    register(ns: string) {
      if (registrations.has(ns)) throw new Error(`settings namespace "${ns}" is already registered`)
      registrations.add(ns)
    },
    get(ns: string) {
      return registrations.has(ns) ? structuredClone(resolved) : undefined
    },
  }
}

/** Minimal ctx double covering everything `apply` touches at mount time. */
function fakeCtx(provider: unknown) {
  const services = new Map<string, unknown>()
  return {
    get: (name: string) => (name === 'settings' ? provider : services.get(name)),
    provide: (name: string, value: unknown) => services.set(name, value),
    on: () => () => {},
    logger: { warn: () => {} },
    store: () => services.get(RESUME_PIN_STORE),
  }
}

describe('resume-pins duplicate-registration tolerance', () => {
  it('mounts twice against the same provider without throwing; both stores are published', () => {
    const provider = fakeProvider(undefined)
    const a = fakeCtx(provider)
    const b = fakeCtx(provider)
    expect(() => apply(a as never, { pinsRoot: '/tmp/does-not-matter' })).not.toThrow()
    expect(() => apply(b as never, { pinsRoot: '/tmp/does-not-matter' })).not.toThrow()
    expect(a.store()).toBeDefined()
    expect(b.store()).toBeDefined()
    expect(provider.registered.has(RESUME_POLICY_NAMESPACE)).toBe(true)
  })

  it('a second module copy of the helper degrades on duplicate registration', async () => {
    const provider = fakeProvider(undefined)
    const { registerNamespaceSafe } = await import('@dsh-cc/settings-ns/src/index.ts?copy2')
    expect(() => registerNamespaceSafe(fakeCtx(provider) as never, RESUME_POLICY_NAMESPACE, ResumePolicySchema)).not.toThrow()
  })

  it('without a settings provider the plugin still mounts', () => {
    const ctx = fakeCtx(undefined)
    expect(() => apply(ctx as never, { pinsRoot: '/tmp/does-not-matter' })).not.toThrow()
    expect(ctx.store()).toBeDefined()
  })
})
