/**
 * Arming validation + router seam types, split from router.ts (size gate).
 * @module
 */

import type { ModelRoutes, ResolvedRoute } from '@dsh-cc/model-aliases'
import type { BoundDecisionRunner } from '@dsh-cc/systemone'
import type { TierLadder } from './tiers.ts'
import type { MoaSettings } from './settings.ts'
import { resolveTiers } from './tiers.ts'
import { resolveJudgeRoute } from './judge-route.ts'

export interface MoaRouteBackend {
  baseURL: string
  apiKey?: string
}

/** Injected seams; every one is optional and degrades to fail-open. */
export interface RouterDeps {
  /** The mounting tree's OWN settings reader (§2.2.1 — never a shared capture). */
  readSettings(): MoaSettings
  /** The `ccModelRoutes` service accessor; absence fail-opens + warns once. */
  routes?: (() => ModelRoutes | undefined) | undefined
  /** System One gateway facts for a resolved judge route. */
  resolveBackend?: ((route: ResolvedRoute) => MoaRouteBackend | undefined) | undefined
  /** Advertised reasoning efforts for a concrete route (effort re-validation). */
  resolveEfforts?: (
    provider: string,
    model: string,
    signal: AbortSignal,
  ) => Promise<readonly string[] | undefined>
  /** Injectable fetch for `systemoneDecide` (tests). */
  fetchImpl?: (typeof fetch) | undefined
  /**
   * Per-use binding of the S1-02 decision runner for context-routing v2
   * (S1-09): the host implements it as
   * `ctx.systemoneDecisions.forAgent(agent)` behind a guard, read once per
   * admission and NEVER cached across uses. Absence is the design's
   * "executor unavailable" row (active serves the live selection, shadow
   * records the reason), never a legacy-classifier call.
   */
  contextDecisions?: ((agent: unknown) => BoundDecisionRunner | undefined) | undefined
  /** Side-car JSONL ledger path accessor; absence disables route logging. */
  ledgerPath?: (() => string | undefined) | undefined
  logger?: { warn(message: string): void } | undefined
  now?: (() => number) | undefined
}

/** Mount-time arming validation outcome (§3.7 / §3.6 window check). */
export interface ArmingValidation { ok: boolean; reason?: string; ladder?: TierLadder | undefined; unarmedReason?: string | undefined }

/**
 * Re-run the arm/validate pass when not yet armed (mount-order race: the
 * settings / `ccModelRoutes` / alias overlay may all settle after mount).
 * Optional; the router and judge call it right before their `validation.ok`
 * gate so callback ordering can never permanently miss.
 */
export type EnsureArmed = () => void

/** Mount-time arming validation (§3.7): resolve all four tiers (four distinct
 * models) and the judge route (context window ≥ classify budget). A failure
 * leaves the feature unarmed with a warn-once — never an exception.
 */
export function validateArming(opts: {
  settings: MoaSettings
  routes?: ModelRoutes | undefined
  logger?: { warn(message: string): void } | undefined
}): ArmingValidation {
  if (opts.routes === undefined) {
    return { ok: false, reason: 'ccModelRoutes service unavailable; tiers cannot be resolved' }
  }
  const ladder = resolveTiers(opts.routes)
  if (!ladder.ok) return { ok: false, reason: ladder.reason }
  const judge = resolveJudgeRoute(opts.settings.judgeRoute, {
    modelRoutes: opts.routes,
    budgetTokens: opts.settings.classifyBudgetTokens,
  })
  if (!judge.ok) return { ok: false, reason: judge.reason }
  return { ok: true, ladder: ladder.tiers }
}
