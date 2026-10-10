/**
 * Wiring regression tests (2026-10-10 dogfood): five stacked bugs made moa
 * silently inert in every real TUI boot even with `moa.enabled: true` —
 * the routing ledger never appeared. The router/judge specs drive
 * `createRequestRouter`/`createAcceptanceJudge` with injected deps, so the
 * `apply(ctx)` wiring layer (and its interaction with `registerNamespaceSafe`)
 * was never exercised. These specs pin the real paths:
 *
 * - A. `registerSettings` had a naive absent-service pre-check that bypassed
 *   settings-ns's own inject-deferral rescue → ship defaults forever.
 * - B. arm/validation froze at mount ("moa disabled") and the router gates on
 *   that frozen object → must retry when the settings service arrives.
 * - C. `buildDeps` captured `ccModelRoutes` at apply time (undefined during
 *   the preset sweep) → judge alias resolution must be lazy.
 * - D. `resolveBackend` passed the cordis *context* where `readUserSection`
 *   expects the settings *service* (hidden by an `as never` cast) → every
 *   System One call fail-opened with "no backend baseURL".
 * - E. the wire `model` field carried a provider prefix the gateway rejects
 *   with a 400 ("not a configured systemone model") — it must be the bare
 *   route model.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { ResolvedRoute } from '@dsh-cc/model-aliases'
import { makeRig, BOOT_PAIR } from './rig.ts'
import { apply, resetMoaCore, getMoaCore, resolveSystemOneBackend } from '../src/index.ts'

/** A describe-shaped settings service double (settings-ns `DescribeFace`). */
function fakeSettingsService(sections: Record<string, unknown>): {
  service: { get: (ns: string) => unknown; register: () => object; describe: () => unknown[] }
  describeCalls: number
} {
  let describeCalls = 0
  return {
    service: {
      get: (ns: string) => sections[ns],
      register: () => ({}),
      describe: () => {
        describeCalls += 1
        return Object.entries(sections).map(([ns, user]) => ({ ns, user }))
      },
    },
    describeCalls,
  }
}

/** The fake plug context: services arrive late (the preset-sweep race). */
function makeLateCtx(options: { moaSection?: unknown; routes?: unknown } = {}) {
  const listeners: { event: string; fn: unknown }[] = []
  const injectCallbacks: (() => void)[] = []
  const warnings: string[] = []
  const services = new Map<string, unknown>()
  const ctx = {
    on: (event: string, fn: unknown) => listeners.push({ event, fn }),
    inject: (_names: string[], cb: () => void) => injectCallbacks.push(cb),
    get: (name: string) => services.get(name),
    logger: { warn: (message: string) => warnings.push(message) },
  }
  /** Make the settings + routes services arrive (the race resolving). */
  const arrive = (sections: Record<string, unknown>, routes?: unknown): void => {
    const { service } = fakeSettingsService(sections)
    services.set('settings', service)
    if (routes !== undefined) services.set('ccModelRoutes', routes)
    for (const cb of [...injectCallbacks]) cb()
  }
  return { ctx, listeners, injectCallbacks, warnings, services, arrive, ...options }
}

/** Four distinct-tier routes (the non-degenerate ladder). */
const healthyRoutes = {
  resolve: (alias: string): ResolvedRoute | undefined =>
    ({ sketch: { provider: 'p', model: 'm1' }, draft: { provider: 'p', model: 'm2' }, blueprint: { provider: 'p', model: 'm3' }, masterplan: { provider: 'p', model: 'm4' } })[alias],
}

describe('moa wiring (apply) — mount-order race', () => {
  it('reads enabled=true and arms after the settings service arrives (A+B)', () => {
    resetMoaCore()
    const rig = makeLateCtx()
    apply(rig.ctx as never)
    // During the preset sweep: ship defaults, unarmed.
    expect(getMoaCore().readSettings().enabled).toBe(false)
    expect(getMoaCore().armingValidation).toEqual({ ok: false, reason: 'moa disabled' })
    // Settings settle afterwards (the real boot order, live-traced 2026-10-10).
    rig.arrive({ moa: { enabled: true } }, healthyRoutes)
    expect(getMoaCore().readSettings().enabled).toBe(true)
    expect(getMoaCore().armingValidation).toEqual({ ok: true, reason: 'armed' })
    expect(getMoaCore().arming.isArmed()).toBe(true)
    expect(rig.warnings).toEqual([])
  })

  it('resolves ccModelRoutes lazily — absent at apply, live at arm time (C)', () => {
    resetMoaCore()
    const rig = makeLateCtx()
    apply(rig.ctx as never)
    // Routes were NOT available at apply time; the arm retry must see them.
    rig.arrive({ moa: { enabled: true } }, healthyRoutes)
    expect(getMoaCore().armingValidation?.ok).toBe(true)
  })

  it('a structural reject does not retry into an armed state', () => {
    resetMoaCore()
    const rig = makeLateCtx()
    apply(rig.ctx as never)
    const degenerate = { resolve: (): ResolvedRoute => ({ provider: 'p', model: 'same' }) }
    rig.arrive({ moa: { enabled: true } }, degenerate)
    expect(getMoaCore().armingValidation?.ok).toBe(false)
    expect(getMoaCore().armingValidation?.reason).toMatch(/degenerate/)
    expect(rig.warnings.filter((w) => w.includes('not armed'))).toHaveLength(1)
    // A later healthy arrival must not resurrect a structurally rejected mount.
    rig.services.set('ccModelRoutes', healthyRoutes)
    for (const cb of rig.injectCallbacks) cb()
    expect(getMoaCore().armingValidation?.ok).toBe(false)
  })

  it('stays defaulted and unarmed when settings never say enabled', () => {
    resetMoaCore()
    const rig = makeLateCtx()
    apply(rig.ctx as never)
    rig.arrive({}, healthyRoutes)
    expect(getMoaCore().readSettings().enabled).toBe(false)
    expect(getMoaCore().armingValidation).toEqual({ ok: false, reason: 'moa disabled' })
  })
})

describe('resolveSystemOneBackend — real readUserSection path (D)', () => {
  const service = fakeSettingsService({
    'llm-pi-ai': { providers: { orchestrix: { baseURL: 'http://127.0.0.1:8080' }, empty: { baseURL: '' } } },
  }).service

  it('resolves the baseURL from the user-layer provider record', () => {
    expect(resolveSystemOneBackend(service as never, { provider: 'orchestrix' })).toEqual({ baseURL: 'http://127.0.0.1:8080' })
  })

  it('returns undefined for a missing or empty provider record', () => {
    expect(resolveSystemOneBackend(service as never, { provider: 'nope' })).toBeUndefined()
    expect(resolveSystemOneBackend(service as never, { provider: 'empty' })).toBeUndefined()
    expect(resolveSystemOneBackend(service as never, { provider: undefined })).toBeUndefined()
  })

  it('returns undefined without a settings service (fail-open, not a throw)', () => {
    expect(resolveSystemOneBackend(undefined, { provider: 'orchestrix' })).toBeUndefined()
  })
})

describe('System One wire model field (E)', () => {
  it('classifies with the bare route model — no provider prefix', async () => {
    const rig = makeRig({ enabled: true })
    await rig.seedCapture(1, [{ role: 'user', content: [{ type: 'text', text: 'trivial question' }], source: { kind: 'user' } } as never])
    await rig.router.listener(rig.payload(1, 1), rig.next)
    expect(rig.classifyModels).toHaveLength(1)
    // Default judge route: provider llmbox_systemone, model bjev — the wire
    // field must be exactly the route model, never `provider/model`.
    expect(rig.classifyModels[0]).toBe('bjev')
    expect(rig.classifyModels[0]).not.toContain('/')
  })

  it('sends the request to the resolved backend baseURL', async () => {
    const rig = makeRig({ enabled: true })
    await rig.seedCapture(1, [{ role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } as never])
    await rig.router.listener(rig.payload(1, 1), rig.next)
    expect(rig.classifyStates).toHaveLength(1)
    expect(rig.warnings).toEqual([])
  })
})

describe('rig sanity', () => {
  it('reports the boot pair the fake header carries', () => {
    expect(BOOT_PAIR).toEqual({ provider: 'mock', model: 'mock' })
  })
})
