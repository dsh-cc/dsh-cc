/**
 * The legacy (v1) admission classifier, split out of `router.ts` (size gate):
 * one System One `systemoneDecide` call over the captured opening text, the
 * four-label argmax with the truncation sentinel, and the applied-index
 * collapse. Behaviour is byte-for-byte the pre-split path — context-routing
 * v2 (`context-routing.ts`) needs the same call in shadow mode, and the
 * router keeps only the admission branch.
 *
 * @module
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ModelRoutes, ResolvedRoute } from '@dsh-cc/model-aliases'
import { capMiddleToTokenBudget, systemoneDecide } from '@dsh-cc/systemone'
import { resolveJudgeRoute } from './judge-route.ts'
import type { MoaSettings } from './settings.ts'
import type { MoaRouteBackend } from './router-arming.ts'
import { collapseAppliedTier, TIER_ALIASES, tierAt, type TierLadder } from './tiers.ts'
import { ROUTING_QUESTION, textOf } from './router-tiers.ts'
import type { RouteRowFields } from './context-routing.ts'

/** Truncation marker handed to `capMiddleToTokenBudget` (head 2/3 + tail 1/3). */
const CROP_MARKER = '[…truncated…]'

/** Injected seams of the legacy classify (all host facts, no routing state). */
export interface LegacyClassifierDeps {
  /** The mounting tree's OWN settings reader (§2.2.1). */
  readSettings(): MoaSettings
  /** The `ccModelRoutes` accessor (judge-route resolution + ladder). */
  routes(): ModelRoutes | undefined
  /** The effective ladder snapshot (the arming snapshot, else a live resolve). */
  ladder(): TierLadder | undefined
  /** System One gateway facts for a resolved judge route. */
  resolveBackend?: ((route: ResolvedRoute) => MoaRouteBackend | undefined) | undefined
  /** Injectable fetch for `systemoneDecide` (tests). */
  fetchImpl?: (typeof fetch) | undefined
  now(): number
  /** Warn-once sink (the missing-backend warning). */
  warn(message: string): void
}

/** One classification: the (collapsed) applied tier and the turnId-less row. */
export interface LegacyClassification {
  tier: number | undefined
  row: RouteRowFields
}

/**
 * Create the legacy classifier. The returned function never throws for a
 * classification miss: every failure is a fail-open `{ tier: undefined, row }`
 * (design §3.2/P3b — the failure tag, never try/catch semantics alone).
 */
export function createLegacyClassifier(
  deps: LegacyClassifierDeps,
): (signal: AbortSignal, opening: UserMessage) => Promise<LegacyClassification> {
  let backendWarned = false

  return async (signal: AbortSignal, opening: UserMessage): Promise<LegacyClassification> => {
    const settings = deps.readSettings()
    const routes = deps.routes()
    const judge = resolveJudgeRoute(settings.judgeRoute, {
      modelRoutes: routes,
      budgetTokens: settings.classifyBudgetTokens,
    })
    const state = capMiddleToTokenBudget(textOf(opening), settings.classifyBudgetTokens, CROP_MARKER)
    const now = deps.now
    const startedAt = now()
    if (!judge.ok) return { tier: undefined, row: { latencyMs: now() - startedAt, truncated: false, failure: judge.reason } }
    // Resolution guarantees a model on the ok branch; if it somehow does
    // not, fail open rather than substitute a model string.
    if (judge.route.model === undefined) {
      return { tier: undefined, row: { latencyMs: now() - startedAt, truncated: false, failure: 'judge route has no model' } }
    }
    const backend = deps.resolveBackend?.(judge.route)
    if (backend === undefined) {
      if (!backendWarned) {
        backendWarned = true
        deps.warn(`moa: no System One backend baseURL for judge route ${judge.route.provider}/${judge.route.model}; failing open`)
      }
      return { tier: undefined, row: { latencyMs: now() - startedAt, truncated: false, failure: 'no backend baseURL' } }
    }
    const result = await systemoneDecide({
      baseURL: backend.baseURL,
      ...(backend.apiKey === undefined ? {} : { apiKey: backend.apiKey }),
      // Wire model == route.model, exactly as the alias/route configured it —
      // never `${provider}/${model}` (provider-prefixing produced a 400 "not a
      // configured systemone model", live-traced 2026-10-10) and never a
      // hardcoded fallback (checked non-undefined above).
      model: judge.route.model,
      state,
      questions: { route: ROUTING_QUESTION },
      timeoutMs: settings.callBudgetMs,
      signal,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    })
    const latencyMs = now() - startedAt
    if (!result.ok) {
      return { tier: undefined, row: { latencyMs, truncated: false, failure: result.failure } }
    }
    const probabilities = result.answers.route?.probabilities
    let tier: number | undefined
    if (probabilities !== undefined) {
      // Argmax over the four tier labels only; every label must carry a
      // number (empty/missing probabilities are failure, P3b).
      let bestProbability = -Infinity
      tier = 0
      for (const [index, label] of TIER_ALIASES.entries()) {
        const p = probabilities[label]
        if (typeof p !== 'number') {
          tier = undefined
          break
        }
        if (p > bestProbability) {
          bestProbability = p
          tier = index
        }
      }
    }
    // Truncation sentinel (§3.2): the gateway silently truncates oversized
    // state; input_tokens pinning at the window means the verdict is garbage.
    const truncated = result.usage.input_tokens >= judge.window
    if (truncated) tier = undefined
    // §3.3 applied-index collapse: a same-model argmax flip is start-index
    // noise — apply/ledger the FIRST index of the contiguous run.
    const applied = tier === undefined ? undefined : collapseAppliedTier(tier, deps.ladder())
    const labels = applied === undefined || tier === undefined ? {} : { tier: tierAt(applied) ?? String(applied), argmaxTier: tierAt(tier) ?? String(tier) }
    return {
      tier: applied,
      row: {
        ...labels,
        ...(probabilities === undefined ? {} : { probabilities }),
        latencyMs,
        truncated,
      },
    }
  }
}
