import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { GAUGE_STRING_PAIR_KEY, pickClassifierRouteName, resetPolicyWarned } from '../src/route-policy.ts'
import type { AliasInspection } from '@dsh-cc/model-aliases'

afterEach(() => {
  resetPolicyWarned()
})

const ARMED_OBJECT = { provider: 'orchestrix', model: 'laya-rl-agent', protocol: 'systemone' }
const ARMED_HEURISTIC = { provider: 'orchestrix', model: 'llmbox_systemone/laya' }

/** Minimal host context face for the policy helper. */
function fakeCtx(opts: {
  routes?: { inspect(model: string | undefined): AliasInspection }
  overlay?: Record<string, unknown>
} = {}): Context {
  return {
    get: (name: string) => {
      if (name === 'ccModelRoutes') return opts.routes
      if (name === 'settings') return opts.overlay === undefined ? undefined : { get: () => opts.overlay }
      return undefined
    },
    logger: { warn: vi.fn() },
  } as unknown as Context
}

function configuredVerdict(): AliasInspection {
  return { kind: 'route', via: 'configured', route: { provider: 'orchestrix', model: 'laya-rl-agent' } }
}

describe('pickClassifierRouteName', () => {
  it('explicit route wins verbatim for any backend', () => {
    expect(pickClassifierRouteName(fakeCtx(), 'gauge', 'haiku')).toBe('gauge')
    expect(pickClassifierRouteName(fakeCtx(), 'some-broken-route', 'auto')).toBe('some-broken-route')
  })

  it("backend 'haiku' → 'haiku' even with an armed gauge", () => {
    const ctx = fakeCtx({ routes: { inspect: () => configuredVerdict() }, overlay: { gauge: ARMED_OBJECT } })
    expect(pickClassifierRouteName(ctx, undefined, 'haiku')).toBe('haiku')
  })

  it("auto + armed gauge (object with protocol systemone) → 'gauge'", () => {
    const ctx = fakeCtx({ routes: { inspect: () => configuredVerdict() }, overlay: { gauge: ARMED_OBJECT } })
    expect(pickClassifierRouteName(ctx, undefined, 'auto')).toBe('gauge')
  })

  it("auto + armed via the model-family heuristic (no protocol field) → 'gauge'", () => {
    const ctx = fakeCtx({ routes: { inspect: () => configuredVerdict() }, overlay: { gauge: ARMED_HEURISTIC } })
    expect(pickClassifierRouteName(ctx, undefined, 'auto')).toBe('gauge')
  })

  it("auto + unconfigured gauge → 'haiku' with ZERO warn calls", () => {
    const ctx = fakeCtx()
    expect(pickClassifierRouteName(ctx, undefined, 'auto')).toBe('haiku')
    expect(ctx.logger.warn).not.toHaveBeenCalled()
  })

  it("string-form gauge pair → 'haiku' + the gauge-string-pair warn-once key", () => {
    const ctx = fakeCtx({ routes: { inspect: () => ({ kind: 'literal', route: { model: 'llmbox_systemone/laya' } }) } })
    expect(pickClassifierRouteName(ctx, undefined, 'auto')).toBe('haiku')
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
    expect((ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain('provider/model pair')
  })

  it('warn dedups per key per process', () => {
    const ctx = fakeCtx({ routes: { inspect: () => ({ kind: 'literal', route: { model: 'llmbox_systemone/laya' } }) } })
    pickClassifierRouteName(ctx, undefined, 'auto')
    pickClassifierRouteName(ctx, undefined, 'auto')
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
    expect(GAUGE_STRING_PAIR_KEY).toBe('permission-rules:gauge-string-pair')
  })

  it('service-unmounted overlay fallback: gauge configured in settings overlay only → gauge', () => {
    const ctx = fakeCtx({ overlay: { gauge: ARMED_OBJECT } })
    expect(pickClassifierRouteName(ctx, undefined, 'auto')).toBe('gauge')
  })
})

describe('createWarnOnce', () => {
  it('emits once per key and resets per process', async () => {
    const { createWarnOnce } = await import('../src/route-policy.ts')
    const warn = vi.fn()
    const warnOnce = createWarnOnce(warn)
    warnOnce('k', 'first')
    warnOnce('k', 'second')
    warnOnce('other', 'third')
    expect(warn.mock.calls.map((c) => c[0])).toEqual(['first', 'third'])
    resetPolicyWarned()
    warnOnce('k', 'again')
    expect(warn).toHaveBeenCalledTimes(3)
  })
})
