/**
 * moa — tiered cascade routing for the main conversation
 * (design docs/plans/2026-10-09-moa-tiered-cascade-routing.md).
 *
 * Plain plugin (advisor-watchdog shape): `apply(ctx)` registers the `moa`
 * settings namespace and constructs the core singletons the later wiring
 * slice consumes. NO event listeners are mounted in this slice.
 *
 * **Wiring seam (S3+)**: the agent/request + agent/pre-step listeners
 * (design §3.2/§3.4) mount here — `apply` should call
 * `registerListeners(ctx, getMoaCore())` once the wiring slice lands; the
 * core (arming machine, bookkeeping, tier helpers) is deliberately stateless
 * of cordis so those listeners can be pure of it too.
 *
 * @module @dsh-cc/moa
 */

import type { Context } from '@deepseek-ai/cordis'
import { ArmingMachine } from './arming.ts'
import { DEFAULT_MOA_SETTINGS, registerSettings, type MoaSettings } from './settings.ts'
import { EscalationBookkeeping } from './state.ts'

export { SETTINGS_NAMESPACE, DEFAULT_MOA_SETTINGS, MAX_ESCALATIONS_CEILING, registerSettings, type MoaSettings, type JudgeRouteObject, type JudgeRouteSetting } from './settings.ts'
export { ArmingMachine, type RequestPair, type DisarmReason } from './arming.ts'
export { TIER_ALIASES, TIER_COUNT, resolveTiers, tierAt, nextTierUp, type TierResolution } from './tiers.ts'
export { DEFAULT_JUDGE_ROUTE, resolveJudgeRoute, resolveContextWindow, normalizeModelId, MOA_MODEL_CONTEXT_WINDOWS, MOA_DEFAULT_CONTEXT_WINDOW, type JudgeRouteResolution } from './judge-route.ts'
export { MOA_ESCALATION_KIND, isMoaEscalationMessage, EscalationBookkeeping, type EscalationState } from './state.ts'

/** What the wiring slice consumes. */
export interface MoaCore {
  /** Live settings reader (hot-reloaded per use). */
  readSettings(): MoaSettings
  /** The MAIN-agent arming state machine (§3.1). */
  arming: ArmingMachine
  /** Per-session escalation bookkeeping (§4). */
  bookkeeping: EscalationBookkeeping
}

let core: MoaCore | undefined

/**
 * Access the plugin core; throws before `apply` ran (a wiring listener
 * cannot exist without its mount anyway).
 */
export function getMoaCore(): MoaCore {
  if (core === undefined) throw new Error('moa core not initialized: apply() has not run')
  return core
}

/** Test seam: drop the singleton (between tests / on hot reload). */
export function resetMoaCore(): void {
  core = undefined
}

/** Cordis plugin id. */
export const name = 'cc-moa'

/**
 * Mount the plugin: register the settings namespace and construct the core.
 * Idempotent — a second apply in one runtime reuses the live core (the
 * settings-ns registration itself is idempotent). No listeners yet.
 * @param ctx - the plug context.
 */
export function apply(ctx: Context): void {
  const read = registerSettings(ctx) ?? (() => DEFAULT_MOA_SETTINGS)
  if (core !== undefined) return
  const arming = new ArmingMachine(() => read().enabled)
  // The wiring slice calls `arming.arm()` at mount when `read().enabled` is
  // true, and `arming.observeRequestModel(pair)` per genuine main-agent turn.
  core = { readSettings: read, arming, bookkeeping: new EscalationBookkeeping() }
}
