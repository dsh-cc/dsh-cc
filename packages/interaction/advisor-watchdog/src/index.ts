/**
 * Advisor watchdog (plan docs/plans/2026-09-23-advisor-watchdog.md): an
 * opt-in second model, on its own cheap lane, that reviews the snapshot
 * window of every completed turn (passive `llm/stream` snapshots, captured
 * at `agent/turn-stopping`) and emits severity-tiered notes
 * (`nit | concern | blocker`) the primary agent consumes via a resolve-time
 * `agent.inject()` with source kind `advisor`.
 *
 * Plain plugin (not a Service): `apply(ctx)`, no isolate key. Settings are
 * registered for /config UX only; the listener reads the raw user file per
 * use. Ship-dark: `cc-advisor.enabled` defaults to false.
 *
 * @module @dsh-cc/advisor-watchdog
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerSettings } from './settings.ts'
import { registerListeners } from './wiring.ts'

export {
  SETTINGS_NAMESPACE,
  SettingsSchema,
  DEFAULT_ADVISOR_SETTINGS,
  registerSettings,
  readUserSettings,
  readUserSettingsSync,
  type AdvisorSettings,
  type Severity,
} from './settings.ts'
export {
  INJECTED_SOURCE_DENYLIST,
  ADVISOR_SOURCE_KIND,
  MAX_DELTA_BYTES,
  fullCursor,
  isGenuineUser,
  renderDelta,
  reviewWindow,
  type Cursor,
  type DeltaMessage,
  type ReviewWindow,
} from './delta.ts'
export {
  DEDUPE_CAPACITY,
  SUPPRESSED_NORMALIZED_PHRASES,
  applyEmissionGuard,
  emptyDrops,
  emptyGuardState,
  normalizeAdvisorNote,
  rememberFingerprint,
  type AdvisorNote,
  type DropCounters,
  type GuardState,
} from './guard.ts'
export { ADVISOR_SYSTEM_PROMPT, parseAdvisorNotes, runAdvisor } from './advise.ts'
export { quarantineHit } from './quarantine.ts'
export { appendJournal, journalFileFor, type AdvisorJournalEntry } from './journal.ts'
export { registerListeners } from './wiring.ts'

/** Cordis plugin id. */
export const name = 'cc-advisor-watchdog'

/**
 * Mount the plugin: register the settings namespace and the two listeners.
 * Plain plugin — no Service, no isolate key.
 * @param ctx - the plug context.
 */
export function apply(ctx: Context): void {
  // /config UX + validation only; the listener reads the raw user file per use.
  registerSettings(ctx)
  registerListeners(ctx)
}
