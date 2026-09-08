/**
 * Pending-aware plan lifecycle phase. plan-mode owns plan state inside the
 * preset realm and folds it into the session-projection unit keyed `'plan'`
 * (state `{active, wanted, running}`, stateVersion 2); its wire view defines
 * pending as `(running?.wanted ?? wanted) !== null && !== active`. This
 * module lifts that derivation into a single predicate every mode-switch
 * surface needs, with a session-log fold fallback for compositions without
 * the projection registry. Pure and browser-safe.
 * @module @dsh-cc/command-permissions/plan-phase
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldPlanMode } from '@dsh-cc/permission-rules'

/**
 * The plan lifecycle as mode switches see it:
 * - `off` — no committed plan, no queued intent; entering dispatches `/plan`.
 * - `entering` — a queued entry is in flight (applies from the next step).
 * - `on` — plan committed, nothing queued; entering again is a no-op.
 * - `leaving` — a queued exit is in flight.
 */
export type PlanPhase = 'off' | 'entering' | 'on' | 'leaving'

/**
 * Structural minimum of plan-mode's projection unit state — re-declared so
 * this package never imports upstream internals.
 */
export interface PlanUnitStateLike {
  readonly active: boolean
  readonly wanted: boolean | null
  readonly running: { readonly wanted: boolean } | null
}

/**
 * Resolve the plan phase from the projection state, falling back to the
 * session-log fold when the projection registry is not composed (custom
 * minimal assemblies; both shipped profiles mount it). The projection, when
 * present, is authoritative — it folds the same log plus replayed
 * `command/run` pairs, so only it sees queued intent.
 * @param events - the session event log (fold fallback).
 * @param planState - the `'plan'` projection unit state, or undefined.
 * @returns the current plan phase.
 */
export function planPhaseOf(
  events: readonly SessionEvent[],
  planState: PlanUnitStateLike | undefined,
): PlanPhase {
  if (planState === undefined) return foldPlanMode(events) ? 'on' : 'off'
  const raw = planState.running?.wanted ?? planState.wanted
  const pending = raw !== null && raw !== undefined && raw !== planState.active ? raw : null
  if (!planState.active) return pending === true ? 'entering' : 'off'
  return pending === false ? 'leaving' : 'on'
}
