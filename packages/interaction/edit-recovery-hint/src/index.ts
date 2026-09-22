/**
 * Edit recovery hint (design doc docs/plans/2026-09-21-edit-fuzzy-matching-and-read-state.md,
 * Track B): when the edit tool fails not-found on a multi-line `old_string`,
 * append a FIXED static recovery-advice message to the same accept decision
 * as an `additionalContexts` entry — model-visible via the harness
 * deferContext loop, without replacing any tool-result content.
 *
 * Plain plugin (not a Service): `apply(ctx)`, no isolate key. Settings are
 * registered for /config UX only; the trigger reads the raw user file per
 * use. Ship-dark: `cc-edit-recovery-hint.enabled` defaults to false.
 *
 * @module @dsh-cc/edit-recovery-hint
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerSettings } from './settings.ts'
import { registerListener } from './wiring.ts'

export { RECOVERY_HINT, isRecoveryCandidate, resultTextOf } from './hint.ts'
export {
  SETTINGS_NAMESPACE,
  SettingsSchema,
  DEFAULT_RECOVERY_HINT_SETTINGS,
  registerSettings,
  readUserEnabled,
  type RecoveryHintSettings,
} from './settings.ts'
export { registerListener } from './wiring.ts'

/**
 * Mount the plugin: register the settings namespace and the post-execute
 * listener. Plain plugin — no Service, no isolate key.
 * @param ctx - the plug context.
 */
export function apply(ctx: Context): void {
  // /config UX + validation only; the listener reads the raw user file per use.
  registerSettings(ctx)
  registerListener(ctx)
}
