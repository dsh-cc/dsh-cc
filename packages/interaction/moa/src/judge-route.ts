/**
 * Judge route resolution (design §3.6): resolve the System One route for
 * classify/judge calls. Default is an explicit object-form bjev route
 * (`llmbox_systemone/bjev`, probe-pinned in permission-rules gauge config);
 * `moa.judgeRoute` may name an alias (resolved via `ModelRoutes`) or be an
 * explicit object-form route used as-is.
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

/** Default judge route (§3.6, probe-pinned provider/model spelling). */
export const DEFAULT_JUDGE_ROUTE: Readonly<ResolvedRoute> = {
  provider: 'llmbox_systemone',
  model: 'bjev',
  protocol: 'systemone',
}

/**
 * Measured System One context windows (2026-10-07 live probe; see the gauge
 * adapter for the full evidence). Keys are bare model ids.
 */
export const MOA_MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  laya: 1024,
  bjev: 16384,
}

/** Fallback window for unknown model ids. */
export const MOA_DEFAULT_CONTEXT_WINDOW = 16384

/** Bare-id normalization: `llmbox_systemone/bjev` → `bjev` (gauge precedent). */
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
 * string via `ModelRoutes`; default bjev route when unconfigured. The route
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
  } else if (setting !== undefined) {
    route = setting
  } else {
    route = DEFAULT_JUDGE_ROUTE
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
