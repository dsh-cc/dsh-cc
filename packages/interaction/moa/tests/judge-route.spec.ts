import { describe, expect, it } from 'vitest'
import type { ModelRoutes, ResolvedRoute } from '@dsh-cc/model-aliases'
import { DEFAULT_JUDGE_ROUTE, MOA_MODEL_CONTEXT_WINDOWS, resolveJudgeRoute, resolveContextWindow, normalizeModelId } from '../src/judge-route.ts'

const route = (model: string): ResolvedRoute => ({ provider: 'p', model })

describe('judge route resolution (§3.6)', () => {
  it('default passes with bjev (mocked window resolver)', () => {
    const out = resolveJudgeRoute(undefined, { budgetTokens: 4000, resolveWindow: () => 16384 })
    expect(out).toEqual({ ok: true, route: DEFAULT_JUDGE_ROUTE, window: 16384 })
    expect(DEFAULT_JUDGE_ROUTE).toEqual({ provider: 'llmbox_systemone', model: 'bjev', protocol: 'systemone' })
  })

  it('alias fallback accepted when the window is large enough', () => {
    const modelRoutes = { resolve: () => route('big-model') } as unknown as ModelRoutes
    const out = resolveJudgeRoute('gauge', { modelRoutes, budgetTokens: 4000, resolveWindow: () => 16384 })
    expect(out.ok).toBe(true)
  })

  it('laya-sized window is rejected', () => {
    const out = resolveJudgeRoute(undefined, { budgetTokens: 4000, resolveWindow: () => MOA_MODEL_CONTEXT_WINDOWS.laya })
    expect(out.ok).toBe(false)
  })

  it('built-in window registry: bjev 16384, laya 1024', () => {
    expect(resolveContextWindow({ provider: 'llmbox_systemone', model: 'bjev' })).toBe(16384)
    expect(resolveContextWindow({ provider: 'llmbox_systemone', model: 'llmbox_systemone/laya' })).toBe(1024)
    expect(normalizeModelId('llmbox_systemone/bjev')).toBe('bjev')
  })

  // Regression (found live, 2026-10-10): an explicit JSON `null` for the
  // optional `moa.judge-route` key is passed through verbatim by schemastery
  // and used to throw a TypeError at the mount-time validateArming call and
  // inside every classifyOnce turn (unguarded), breaking the plugin mount and
  // the agent/request waterfall. Null means "unset" — it must fall back to
  // the default bjev route and never throw.
  it('an explicit JSON null falls back to the default route (never throws)', () => {
    const out = resolveJudgeRoute(null as never, { budgetTokens: 4000, resolveWindow: () => 16384 })
    expect(out).toEqual({ ok: true, route: DEFAULT_JUDGE_ROUTE, window: 16384 })
  })

  it('a malformed object form is refused with ok:false, not a TypeError', () => {
    const out = resolveJudgeRoute({ model: 'bjev' } as never, { budgetTokens: 4000, resolveWindow: () => 16384 })
    expect(out).toMatchObject({ ok: false })
    expect((out as { reason: string }).reason).toContain('provider and model')
  })
})
