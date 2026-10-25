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
 *   that frozen object → must retry until armed: on settings + ccModelRoutes
 *   arrival AND right before the router/judge gate (no failure reason is
 *   final — routes-unavailable and a temporarily degenerate ladder retry).
 * - C. `buildDeps` captured `ccModelRoutes` at apply time (undefined during
 *   the preset sweep) → judge alias resolution must be lazy.
 * - D. `resolveBackend` passed the cordis *context* where `readUserSection`
 *   expects the settings *service* (hidden by an `as never` cast) → every
 *   System One call fail-opened with "no backend baseURL".
 * - E. the wire `model` field carried a provider prefix the gateway rejects
 *   with a 400 ("not a configured systemone model") — it must equal the
 *   resolved route's `model` verbatim (default: the `gauge` alias), never
 *   `provider/model` and never a hardcoded model id.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { ResolvedRoute } from '@dsh-cc/model-aliases'
import { makeRig, BOOT_PAIR, GAUGE_ROUTE } from './rig.ts'
import { apply, resetMoaCore, getMoaCore, moaUnarmedReason, resolveSystemOneBackend, buildDeps, DEFAULT_MOA_SETTINGS } from '../src/index.ts'

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
  const injectCallbacks: { names: string[]; cb: () => void }[] = []
  const warnings: string[] = []
  const services = new Map<string, unknown>()
  const ctx = {
    on: (event: string, fn: unknown) => listeners.push({ event, fn }),
    inject: (names: string[], cb: () => void) => injectCallbacks.push({ names, cb }),
    get: (name: string) => services.get(name),
    logger: { warn: (message: string) => warnings.push(message) },
  }
  /** Cordis inject semantics: a callback fires once ALL its names are present. */
  const flush = (): void => {
    for (const { names, cb } of [...injectCallbacks]) if (names.every((n) => services.has(n))) cb()
  }
  /** Make the settings (and optionally routes) services arrive (the race resolving). */
  const arrive = (sections: Record<string, unknown>, routes?: unknown): void => {
    const { service } = fakeSettingsService(sections)
    services.set('settings', service)
    if (routes !== undefined) services.set('ccModelRoutes', routes)
    flush()
  }
  /** Provide / replace `ccModelRoutes` on its own (app-level service settling later). */
  const provideRoutes = (routes: unknown): void => {
    services.set('ccModelRoutes', routes)
    flush()
  }
  return { ctx, listeners, injectCallbacks, warnings, services, arrive, provideRoutes, ...options }
}

/** Four distinct-tier routes (the non-degenerate ladder) + a System One `gauge` lane. */
const healthyRoutes = {
  resolve: (alias: string): ResolvedRoute | undefined =>
    ({ sketch: { provider: 'p', model: 'm1' }, draft: { provider: 'p', model: 'm2' }, blueprint: { provider: 'p', model: 'm3' }, masterplan: { provider: 'p', model: 'm4' }, gauge: GAUGE_ROUTE })[alias],
}

/** Alias overlay not mounted yet: every lane collapses to one model. */
const degenerateRoutes = { resolve: (): ResolvedRoute => ({ provider: 'p', model: 'same' }) }

/** Fire one full PR-2 step through the apply-mounted listeners:
 * claim (capture) → assemble (classify seam) → pre-step (observe + row
 * splice) → request (overlay). */
let firedTurn = 0
async function fireRequest(rig: ReturnType<typeof makeLateCtx>): Promise<void> {
  const turn = ++firedTurn
  const agent = { session: { requestHeader: () => ({ config: { ...BOOT_PAIR } }) }, inject: () => {} }
  const find = (event: string) => rig.listeners.find((l) => l.event === event)?.fn as (a: unknown, b: unknown, c?: unknown) => Promise<unknown>
  const claimed = find('agent/inbox/claimed')
  await claimed({ agent, message: { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, turn }, async () => ({}))
  const assemble = find('system-prompt/assemble')
  await assemble({ variables: { provider: BOOT_PAIR.provider, model: BOOT_PAIR.model } }, { agent, signal: new AbortController().signal }, async () => ({
    variables: { provider: BOOT_PAIR.provider, model: BOOT_PAIR.model },
  }))
  const preStep = find('agent/pre-step')
  await preStep({ agent, turn, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  const request = find('agent/request')
  await request(
    { agent, turn, step: 1, signal: new AbortController().signal },
    async () => ({ provider: 'mock', model: 'mock', messages: [] }),
  )
}

describe('moa wiring (apply) — mount-order race', () => {
  it('reads enabled=true and arms after the settings service arrives (A+B)', () => {
    resetMoaCore()
    const rig = makeLateCtx()
    apply(rig.ctx as never)
    // During the preset sweep: ship defaults, unarmed.
    expect(getMoaCore().armingValidation).toEqual({ ok: false, reason: 'moa disabled' })
    // Settings settle afterwards (the real boot order, live-traced 2026-10-10).
    rig.arrive({ moa: { enabled: true } }, healthyRoutes)
    expect(getMoaCore().armingValidation).toMatchObject({ ok: true, reason: 'armed' })
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

  it('settings first WITHOUT routes → unarmed; routes arrive later → armed', () => {
    resetMoaCore()
    const rig = makeLateCtx()
    apply(rig.ctx as never)
    rig.arrive({ moa: { enabled: true } })
    // The combined inject has not fired (routes absent); the mount-time
    // attempt saw defaults. Still unarmed, but NOT frozen.
    expect(getMoaCore().armingValidation?.ok).toBe(false)
    expect(getMoaCore().arming.isArmed()).toBe(false)
    rig.provideRoutes(healthyRoutes)
    expect(getMoaCore().armingValidation).toMatchObject({ ok: true, reason: 'armed' })
    expect(getMoaCore().arming.isArmed()).toBe(true)
  })

  it('routes-unavailable is retried on the next router firing (ensureArmed before the gate)', async () => {
    resetMoaCore()
    const rig = makeLateCtx()
    apply(rig.ctx as never)
    rig.arrive({ moa: { enabled: true } })
    // Simulate the inject callback having raced ahead of the routes service
    // (settings-only snapshot) — then routes land without any inject firing.
    for (const { cb } of rig.injectCallbacks) cb()
    expect(getMoaCore().armingValidation?.reason).toMatch(/ccModelRoutes service unavailable/)
    rig.services.set('ccModelRoutes', healthyRoutes)
    await fireRequest(rig)
    expect(getMoaCore().armingValidation).toMatchObject({ ok: true, reason: 'armed' })
  })

  it('degenerate ladder (alias overlay not mounted yet) → later healthy routes arm it', async () => {
    resetMoaCore()
    const rig = makeLateCtx()
    apply(rig.ctx as never)
    rig.arrive({ moa: { enabled: true } }, degenerateRoutes)
    expect(getMoaCore().armingValidation?.ok).toBe(false)
    expect(getMoaCore().armingValidation?.reason).toMatch(/degenerate/)
    // Retries with the same reason warn only once.
    await fireRequest(rig)
    await fireRequest(rig)
    expect(rig.warnings.filter((w) => w.includes('not armed'))).toHaveLength(1)
    // The overlay mounts in place (no service re-provide → no inject fire):
    // the per-firing ensureArmed picks it up.
    rig.services.set('ccModelRoutes', healthyRoutes)
    await fireRequest(rig)
    expect(getMoaCore().armingValidation).toMatchObject({ ok: true, reason: 'armed' })
    expect(getMoaCore().armingValidation?.ladder).toHaveLength(4) // §3.2.4 snapshot
    expect(getMoaCore().arming.isArmed()).toBe(true)
  })

  it('stays unarmed while the default gauge alias is not a System One route', () => {
    resetMoaCore()
    const rig = makeLateCtx()
    apply(rig.ctx as never)
    const chatGauge = { resolve: (alias: string) => (alias === 'gauge' ? { provider: 'p', model: 'chat' } : healthyRoutes.resolve(alias)) }
    rig.arrive({ moa: { enabled: true } }, chatGauge)
    expect(getMoaCore().armingValidation?.ok).toBe(false)
    expect(getMoaCore().armingValidation?.reason).toContain('gauge')
  })

  it('stays defaulted and unarmed when settings never say enabled', () => {
    resetMoaCore()
    const rig = makeLateCtx()
    apply(rig.ctx as never)
    rig.arrive({}, healthyRoutes)
    expect(getMoaCore().armingValidation).toEqual({ ok: false, reason: 'moa disabled' })
    // §4: the default-off population NEVER produces an unarmed reason.
    expect(moaUnarmedReason()).toBeUndefined()
  })

  it('exposes the enabled-but-unarmed reason; arming success clears it (§4)', () => {
    resetMoaCore()
    const rig = makeLateCtx()
    apply(rig.ctx as never)
    rig.arrive({ moa: { enabled: true } }, degenerateRoutes)
    expect(moaUnarmedReason()).toMatch(/degenerate/)
    // The overlay mounts in place: the retry arms and the reason clears.
    rig.provideRoutes(healthyRoutes)
    expect(moaUnarmedReason()).toBeUndefined()
    expect(getMoaCore().armingValidation?.unarmedReason).toBeUndefined()
  })
})

describe("buildDeps resolveEfforts — lazy llm service (F, 2026-10-11 dogfood)", () => {
  it('resolves the llm service per call, not at apply time', async () => {
    const rig = makeLateCtx()
    // The live trap (pool-lib probe 2026-10-11): an eager apply-time `ctx.llm`
    // access throws "cannot get property llm without inject" in a real boot —
    // buildDeps must never touch the service property, and must find the
    // service through `ctx.get` lazily so a late arrival still wires effort
    // validation.
    const deps = buildDeps(rig.ctx as never, () => DEFAULT_MOA_SETTINGS)
    // No llm service yet: fail soft (undefined efforts, the router keeps its
    // degrade semantics) — and never throw.
    await expect(deps.resolveEfforts?.('p', 'm1', new AbortController().signal)).resolves.toBeUndefined()
    // The service arrives late (base layer settles after the preset sweep).
    rig.services.set('llm', {
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }, { id: 'max' }] } }),
    })
    await expect(deps.resolveEfforts?.('p', 'm1', new AbortController().signal)).resolves.toEqual(['off', 'high', 'max'])
  })

  it('maps resolveModelInfo rejections to undefined (fail-open, never a throw)', async () => {
    const rig = makeLateCtx()
    rig.services.set('llm', {
      resolveModelInfo: async () => { throw new Error('catalog down') },
    })
    const deps = buildDeps(rig.ctx as never, () => DEFAULT_MOA_SETTINGS)
    await expect(deps.resolveEfforts?.('p', 'm1', new AbortController().signal)).resolves.toBeUndefined()
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
  it('wire model equals the resolved default-alias route.model verbatim', async () => {
    const rig = makeRig({ enabled: true })
    await rig.seedCapture(1, [{ role: 'user', content: [{ type: 'text', text: 'trivial question' }], source: { kind: 'user' } } as never])
    await rig.assemble(1)
    await rig.router.listener(rig.payload(1, 1), rig.next)
    expect(rig.classifyModels).toHaveLength(1)
    // Default judge = the `gauge` alias; the fake resolves it to
    // { provider: 'gw', model: 'gw/judge-model' }. The wire field is exactly
    // route.model — never `${provider}/${model}` re-prefixed.
    expect(rig.classifyModels[0]).toBe(GAUGE_ROUTE.model)
    expect(rig.classifyModels[0]).not.toBe(`${GAUGE_ROUTE.provider}/${GAUGE_ROUTE.model}`)
  })

  it('wire model equals an explicit object-form route.model (bare id stays bare)', async () => {
    const rig = makeRig({ enabled: true })
    rig.settings.judgeRoute = { provider: 'gw', model: 'judge-bare' }
    await rig.seedCapture(1, [{ role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } as never])
    await rig.assemble(1)
    await rig.router.listener(rig.payload(1, 1), rig.next)
    expect(rig.classifyModels).toEqual(['judge-bare'])
  })

  it('sends the request to the resolved backend baseURL', async () => {
    const rig = makeRig({ enabled: true })
    await rig.seedCapture(1, [{ role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } as never])
    await rig.assemble(1)
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

describe('moa wiring (apply) — subagent scope', () => {
  /** Fire one mounted listener (request or pre-step) with an explicit payload. */
  const mounted = (rig: ReturnType<typeof makeLateCtx>, event: string): ((payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) =>
    rig.listeners.find((l) => l.event === event)?.fn as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>

  it('a subagent request through the apply-mounted router disarms nothing and consumes no root turn', async () => {
    resetMoaCore()
    const rig = makeLateCtx()
    apply(rig.ctx as never)
    rig.arrive({ moa: { enabled: true } }, healthyRoutes)
    expect(getMoaCore().armingValidation).toMatchObject({ ok: true, reason: 'armed' })

    const request = mounted(rig, 'agent/request')
    const assemble = mounted(rig, 'system-prompt/assemble')
    const claimed = mounted(rig, 'agent/inbox/claimed')
    const next = async (): Promise<unknown> => ({ provider: 'mock', model: 'mock', messages: [] })
    const assembleNext = async (): Promise<unknown> => ({ variables: { provider: BOOT_PAIR.provider, model: BOOT_PAIR.model } })
    const rootAgent = { session: { requestHeader: () => ({ config: { ...BOOT_PAIR } }) }, inject: () => {} }
    // The child reports a FOREIGN pair — an unguarded child request would
    // observe it and disarm the machine for the rest of the session.
    const subAgent = {
      session: { header: { origin: 'subagent' }, requestHeader: () => ({ config: { provider: 'foreign', model: 'child-model' } }) },
      inject: () => {},
    }
    const childResolved = (await request({ agent: subAgent, turn: 1, step: 1, signal: new AbortController().signal }, next)) as {
      model?: string
    }
    expect(childResolved.model).toBe('mock') // passthrough, no override
    expect(getMoaCore().arming.isArmed()).toBe(true) // foreign pair NOT observed
    expect(rig.warnings).toEqual([]) // no classify attempt fired for the child
    // A child's claimed message writes neither the capture map nor the
    // last-claimed turn (subagent-guarded on write).
    await claimed({ agent: subAgent, message: { role: 'user', content: [{ type: 'text', text: 'child' }], source: { kind: 'user' } }, turn: 1 }, async () => ({}))

    // The root's own turn-1 request is still a NEW turn (the child's
    // same-numbered request did not consume it) and reaches judge-backend
    // resolution — which, with no llm-pi-ai user section in this rig,
    // fail-opens with the warn-once backend row.
    await claimed({ agent: rootAgent, message: { role: 'user', content: [{ type: 'text', text: 'root prompt' }], source: { kind: 'user' } }, turn: 1 }, async () => ({}))
    await assemble({ variables: { provider: BOOT_PAIR.provider, model: BOOT_PAIR.model } }, { agent: rootAgent, signal: new AbortController().signal }, assembleNext)
    await request({ agent: rootAgent, turn: 1, step: 1, signal: new AbortController().signal }, next)
    expect(rig.warnings.some((w) => w.includes('no System One backend'))).toBe(true)
  })
})
