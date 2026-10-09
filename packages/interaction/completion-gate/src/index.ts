/**
 * Completion gate (plan docs/plans/2026-10-09-runtime-verified-completion.md):
 * records hashed tool-execution receipts (session events + a hash-only JSONL
 * ledger) and nudges at `agent/turn-stopping` when the final assistant message
 * claims done-ness with no matching executed evidence since the last genuine
 * user message (§3.3/§3.4).
 *
 * Plain plugin (not a Service): `apply(ctx)`, no isolate key. Settings are
 * registered for /config UX only; the listeners read the raw user file per
 * use. Ship-dark: `cc-completion-gate.enabled` defaults to false — receipts
 * (hashed fields) are always recorded, command heads only while enabled
 * (§3.5).
 *
 * @module @dsh-cc/completion-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerSettings } from './settings.ts'
import { registerListeners } from './wiring.ts'

// Side-effectful module load: KNOWN_SESSION_EVENT_TYPES registration.
import './events.ts'

export {
  RECEIPT_EVENT,
  NUDGE_EVENT,
  RESOLVED_EVENT,
  COMPLETION_GATE_SOURCE_KIND,
  type Receipt,
} from './events.ts'
export {
  HEAD_MAX_BYTES,
  scrubHead,
  truncateUtf8,
} from './scrub.ts'
export {
  segmentHead,
  loadClaims,
  matchPhrases,
  receiptSatisfies,
  type CompiledClaim,
} from './claims.ts'
export {
  stableJson,
  digest16,
  buildReceipt,
} from './receipts.ts'
export {
  RETENTION_FILES,
  appendLedgerRow,
  ledgerRowOf,
  ledgerFileFor,
  sweepReceipts,
} from './ledger.ts'
export {
  DELEGATION_TOOL_IDS,
  MAX_LINEAGE_DEPTH,
  LineageRegistry,
  countGenuineUserMessages,
  walkRoot,
  horizonDegraded,
  type LiftEntry,
  type SessionLike,
} from './lineage.ts'
export {
  SETTINGS_NAMESPACE,
  SettingsSchema,
  DEFAULT_GATE_SETTINGS,
  registerSettings,
  readUserSettings,
  readUserSettingsSync,
  type GateSettings,
} from './settings.ts'
export { createPostExecuteHandler, createTurnStoppingHandler, registerListeners, type GateDeps } from './wiring.ts'
export {
  evaluateTurnStopping,
  maybeResolveOnReceipt,
  findJudgedMessage,
  isTopLevel,
  suppressedByOwnNudge,
  windowStartIndex,
  type EvalAgent,
  type EvalEvent,
  type EvalOutcome,
  type EvalSession,
  type EvaluateDeps,
} from './evaluate.ts'

/** Cordis plugin id. */
export const name = 'cc-completion-gate'

/**
 * Mount the plugin: register the settings namespace and the listeners
 * registered so far (`tools/post-execute`; `agent/turn-stopping` lands in the
 * next slice). Plain plugin — no Service, no isolate key.
 * @param ctx - the plug context.
 */
export function apply(ctx: Context): void {
  registerSettings(ctx)
  registerListeners(ctx)
}
