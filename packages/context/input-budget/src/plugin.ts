/**
 * Cordis plugin entry — what the preset's `input-budget` row mounts (plan doc
 * `docs/plans/2026-11-12-per-step-input-budget-governor.md` §"Package & seam").
 *
 * The package publishes no Service, so the row carries no isolate key and the
 * plugin declares no `inject`. The whole behavior is the prepended
 * `agent/pre-step` listener (plus session-state hygiene), registered on the
 * PRESET context: each preset tree gates its own agents with its own per-session
 * clocks and backlogs. Registering as a fiber effect is what makes a preset
 * unload remove the listener with it.
 *
 * @module @dsh-cc/input-budget/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerGovernorListener } from './listener.ts'

/** Cordis plugin id — the preset row id. */
export const name = 'input-budget'

/**
 * Mount the governor for the calling preset.
 * @param ctx - the preset context mounting this plugin.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => registerGovernorListener(ctx), 'input-budget: release governor listener')
}
