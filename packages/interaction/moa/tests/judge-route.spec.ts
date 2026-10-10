import { describe, expect, it } from 'vitest'
import type { ModelRoutes, ResolvedRoute } from '@dsh-cc/model-aliases'
import { DEFAULT_JUDGE_ALIAS, MOA_MODEL_CONTEXT_WINDOWS, resolveJudgeRoute, resolveContextWindow, normalizeModelId } from '../src/judge-route.ts'

const route = (model: string): ResolvedRoute => ({ provider: 'p', model })

/** A fake `ModelRoutes` whose `gauge` lane points at a System One route. */
const GAUGE: ResolvedRoute = { provider: 'gw', model: 'gw/judge-model', protocol: 'systemone' }
const gaugeRoutes = (target: ResolvedRoute | null = GAUGE): { routes: ModelRoutes; asked: string[] } => {
  const asked: string[] = []
  const routes = {
    resolve: (alias: string) => {
      asked.push(alias)
      return alias === DEFAULT_JUDGE_ALIAS ? (target ?? undefined) : undefined
    },
  } as unknown as ModelRoutes
  return { routes, asked }
}

describe('judge route resolution (§3.6)', () => {
  it('the default is the gauge ALIAS, not a concrete model id', () => {
    expect(DEFAULT_JUDGE_ALIAS).toBe('gauge')
  })

  it('unset → resolves the gauge alias via ModelRoutes (mocked window resolver)', () => {
    const { routes, asked } = gaugeRoutes()
    const out = resolveJudgeRoute(undefined, { modelRoutes: routes, budgetTokens: 4000, resolveWindow: () => 16384 })
    expect(out).toEqual({ ok: true, route: GAUGE, window: 16384 })
    expect(asked).toEqual(['gauge'])
  })

  it('unset without ModelRoutes → unarmed (never an invented route)', () => {
    const out = resolveJudgeRoute(undefined, { budgetTokens: 4000, resolveWindow: () => 16384 })
    expect(out.ok).toBe(false)
    expect((out as { reason: string }).reason).toMatch(/gauge.*unavailable/)
  })

  it('unset with an unresolvable gauge alias → unarmed', () => {
    const { routes } = gaugeRoutes(null)
    const out = resolveJudgeRoute(undefined, { modelRoutes: routes, budgetTokens: 4000, resolveWindow: () => 16384 })
    expect(out.ok).toBe(false)
    expect((out as { reason: string }).reason).toContain('does not resolve')
  })

  it('unset with gauge inheriting a chat peer (non-System One) → unarmed', () => {
    const { routes } = gaugeRoutes({ provider: 'p', model: 'chat-model' })
    const out = resolveJudgeRoute(undefined, { modelRoutes: routes, budgetTokens: 4000, resolveWindow: () => 16384 })
    expect(out.ok).toBe(false)
    expect((out as { reason: string }).reason).toContain('not a System One route')
  })

  it('an explicit alias is accepted when the window is large enough', () => {
    const modelRoutes = { resolve: () => route('big-model') } as unknown as ModelRoutes
    const out = resolveJudgeRoute('my-judge', { modelRoutes, budgetTokens: 4000, resolveWindow: () => 16384 })
    expect(out.ok).toBe(true)
  })

  it('a laya-sized window behind the default alias is rejected', () => {
    const { routes } = gaugeRoutes()
    const out = resolveJudgeRoute(undefined, { modelRoutes: routes, budgetTokens: 4000, resolveWindow: () => MOA_MODEL_CONTEXT_WINDOWS.laya })
    expect(out.ok).toBe(false)
  })

  it('measured window registry (lookup for resolved routes only): bjev 16384, laya 1024', () => {
    expect(resolveContextWindow({ provider: 'x', model: 'bjev' })).toBe(16384)
    expect(resolveContextWindow({ provider: 'x', model: 'x/laya' })).toBe(1024)
    expect(normalizeModelId('x/bjev')).toBe('bjev')
  })

  // Regression (found live, 2026-10-10): an explicit JSON `null` for the
  // optional `moa.judge-route` key is passed through verbatim by schemastery
  // and used to throw a TypeError at the mount-time validateArming call and
  // inside every classifyOnce turn (unguarded). Null means "unset" — it must
  // fall back to the default ALIAS and never throw.
  it('an explicit JSON null falls back to the default alias (never throws)', () => {
    const { routes } = gaugeRoutes()
    const out = resolveJudgeRoute(null as never, { modelRoutes: routes, budgetTokens: 4000, resolveWindow: () => 16384 })
    expect(out).toEqual({ ok: true, route: GAUGE, window: 16384 })
  })

  it('a malformed object form is refused with ok:false, not a TypeError', () => {
    const out = resolveJudgeRoute({ model: 'm' } as never, { budgetTokens: 4000, resolveWindow: () => 16384 })
    expect(out).toMatchObject({ ok: false })
    expect((out as { reason: string }).reason).toContain('provider and model')
  })
})
