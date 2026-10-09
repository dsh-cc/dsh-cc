/**
 * Retry-attendant (design doc docs/plans/2026-10-09-verify-before-retry.md):
 * ambiguous-outcome guidance (M1) and identical-retry escalation (M2) for
 * mutating tool calls. Slice 1 = detection core (class table, digest,
 * augmentations); slice 2 = the live wiring: settings, per-session state, and
 * the post-execute / pre-execute / resolution-seam listeners.
 *
 * @module @dsh-cc/retry-attendant
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerRetrySettings } from './settings.ts'
import { registerListeners } from './wiring.ts'
import './types.ts'

export { CLASS_TABLE, classify, type ClassRow } from './classes.ts'
export { digestKey, effectFields, stableJson } from './digest.ts'
export { firstShellToken, secondShellToken, stripLeadingAssignments } from './shell-words.ts'
export {
  clearEntry,
  consumeDispatch,
  createState,
  liveEntry,
  recordEntry,
  releaseReservation,
  reserve,
  resolveEntries,
  sweep,
  type RetryEntry,
  type RetryState,
} from './state.ts'
export {
  DEFAULT_RETRY_SETTINGS,
  SETTINGS_NAMESPACE,
  SettingsSchema,
  readUserSettings,
  registerRetrySettings,
  resolveSettings,
  type RetrySettings,
} from './settings.ts'
export { registerListeners } from './wiring.ts'

/**
 * Mount the plugin: register the settings namespace (for /config UX and
 * validation only — the listeners read the raw user file per use), then the
 * listeners. Plain plugin — no Service, no isolate key.
 * @param ctx - the plug context.
 */
export function apply(ctx: Context): void {
  registerRetrySettings(ctx)
  registerListeners(ctx)
}
