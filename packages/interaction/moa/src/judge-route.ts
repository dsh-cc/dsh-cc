/**
 * Judge route resolution (design §3.6): resolve the System One route for
 * classify/judge calls. The default is the `gauge` lane ALIAS
 * (`DEFAULT_JUDGE_ALIAS`), resolved via `ModelRoutes` — code never ships a
 * concrete provider/model id. `moa.judgeRoute` may name another alias
 * (resolved via `ModelRoutes`) or be an explicit user-configured object-form
 * route used as-is. When the default alias does not resolve to a concrete
 * System One route (routes service absent, aliases not loaded yet, or `gauge`
 * still inheriting a chat peer), resolution fails and the feature stays
 * unarmed — a route is never invented.
 *
 * Window check (§3.6): the route is accepted only if its resolved context
 * window ≥ `classifyBudgetTokens` — a 1024-window laya route fail-opens every
 * turn while charging the TTFT tax.
 *
 * ponytail: the per-model window registry here duplicates the gauge adapter's
 * `GAUGE_MODEL_CONTEXT_WINDOWS` (permission-rules/src/gauge-adapter.ts).
 * permission-rules does not export it publicly (its API is `.`/`./invariant`/
 * `./types`, §3.6 reuse boundary), so the two measured constants are
 * replicated; consolidate when a shared windows package exists.
 *
 * @module
 */

import type { ModelRoutes, ResolvedRoute } from '@dsh-cc/model-aliases'
import type { JudgeRouteSetting } from './settings.ts'

/**
 * Default judge alias (§3.6 gauge path). Alias only — no hardcoded model id:
 * the concrete route is whatever the user's `gauge` lane resolves to.
 */
export const DEFAULT_JUDGE_ALIAS = 'gauge'

/**
 * Measured System One context windows (2026-10-07 live probe; see the gauge
 * adapter for the full evidence). Keys are bare model ids. This is a
 * MEASUREMENT lookup for whatever route an alias resolved to — it is never
 * used to pick or invent a route.
 */
export const MOA_MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  laya: 1024,
  bjev: 16384,
}

/** Fallback window for unknown model ids. */
export const MOA_DEFAULT_CONTEXT_WINDOW = 16384

/** Bare-id normalization: `gateway/model` → `model` (gauge precedent). */
export function normalizeModelId(model: string): string {
  const slash = model.lastIndexOf('/')
  return slash === -1 ? model : model.slice(slash + 1)
}

/**
 * Resolved context window for a route's model: measured registry, else the
 * default. Injectable for tests and for future provider-record reads.
 */
export function resolveContextWindow(route: ResolvedRoute): number {
  if (route.model === undefined) return MOA_DEFAULT_CONTEXT_WINDOW
  return MOA_MODEL_CONTEXT_WINDOWS[normalizeModelId(route.model)] ?? MOA_DEFAULT_CONTEXT_WINDOW
}

/** Either an accepted route or a failure (feature stays unarmed, warn-once). */
export type JudgeRouteResolution =
  | { ok: true; route: ResolvedRoute; window: number }
  | { ok: false; reason: string }

/**
 * Resolve the judge route (§3.6). Order: explicit object form as-is; alias
 * string via `ModelRoutes`; the `gauge` default alias via `ModelRoutes` when
 * unconfigured (must resolve to a `protocol: 'systemone'` route). The route
 * passes only when `resolveContextWindow(route) >= budgetTokens`.
 */
export function resolveJudgeRoute(
  setting: JudgeRouteSetting | undefined,
  opts: {
    modelRoutes?: ModelRoutes | undefined
    budgetTokens: number
    resolveWindow?: (route: ResolvedRoute) => number
  },
): JudgeRouteResolution {
  const resolveWindow = opts.resolveWindow ?? resolveContextWindow
  let route: ResolvedRoute
  if (typeof setting === 'string') {
    const resolved = opts.modelRoutes?.resolve(setting)
    if (resolved === undefined || resolved.provider === undefined || resolved.model === undefined) {
      return { ok: false, reason: `moa.judgeRoute alias "${setting}" does not resolve to a concrete route` }
    }
    route = resolved
  } else if (setting != null && typeof setting === 'object') {
    // Explicit object form. Guard the shape: a malformed setting (e.g. an
    // explicit JSON `null`, which schemastery passes through verbatim) must
    // degrade to a warn-once unarmed state, never throw into the waterfall
    // or the mount path (validateArming promises "never an exception").
    if (setting.provider === undefined || setting.model === undefined) {
      return { ok: false, reason: `moa.judgeRoute object form requires provider and model` }
    }
    route = setting
  } else if (setting == null) {
    // Unset — including an explicit JSON `null`, which schemastery passes
    // through verbatim: null means "no value" for an optional key, same as
    // absence. Falls to the default ALIAS — never a hardcoded route.
    if (opts.modelRoutes === undefined) {
      return { ok: false, reason: `default judge alias "${DEFAULT_JUDGE_ALIAS}" cannot resolve: ccModelRoutes service unavailable` }
    }
    const resolved = opts.modelRoutes.resolve(DEFAULT_JUDGE_ALIAS)
    if (resolved === undefined || resolved.provider === undefined || resolved.model === undefined) {
      return { ok: false, reason: `default judge alias "${DEFAULT_JUDGE_ALIAS}" does not resolve to a concrete route` }
    }
    // An unconfigured `gauge` lane inherits its chat peer (haiku): that is
    // not a System One model, so it cannot serve classify/judge calls.
    if (resolved.protocol !== 'systemone') {
      return { ok: false, reason: `default judge alias "${DEFAULT_JUDGE_ALIAS}" is not a System One route; configure the gauge lane or moa.judge-route` }
    }
    route = resolved
  } else {
    return { ok: false, reason: `moa.judgeRoute has an unsupported shape (${typeof setting})` }
  }
  const window = resolveWindow(route)
  if (window < opts.budgetTokens) {
    return {
      ok: false,
      reason: `judge route ${route.provider ?? '?'}/${route.model ?? '?'} window ${window} < classify budget ${opts.budgetTokens}`,
    }
  }
  return { ok: true, route, window }
}
