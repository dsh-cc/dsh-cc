/**
 * Completion gate (plans docs/plans/2026-10-09-runtime-verified-completion.md
 * and docs/plans/2026-11-17-completion-gate-enforce-mode.md): records hashed
 * tool-execution receipts (session events + a hash-only JSONL ledger) and, at
 * `agent/turn-stopping`, checks the final assistant message for done-ness
 * claims with no matching executed evidence since the last genuine user
 * message (§3.3/§3.4).
 *
 * Two modes (`cc-completion-gate.mode`, default `nudge`): `nudge` injects at
 * most `nudges-per-session` advisory evidence nudges; `enforce` re-opens the
 * turn until the claims are satisfied by a successful execution, retracted
 * lexically, or the window-scoped `enforce-max-cycles` budget is spent — then
 * the turn stalls, and the `turn/end` reconciliation records
 * `completion-gate/unverified` when the final message still carries the claim
 * (§3.2/§3.5 of the enforce plan). Both markers are session-stream only.
 *
 * Plain plugin (not a Service): `apply(ctx)`, no isolate key. Settings are
 * registered for /config UX only; the listeners read the raw user file per
 * use. Default ON since 2026-11-11: `cc-completion-gate.enabled` defaults to
 * true — receipts (hashed fields) are always recorded, command heads and the
 * turn-stopping gate only while enabled (§3.5); opt out with `false`.
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
  EXHAUSTED_EVENT,
  UNVERIFIED_EVENT,
  COMPLETION_GATE_SOURCE_KIND,
  type EnforceMarker,
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
  type GateMode,
  type GateSettings,
} from './settings.ts'
export {
  createPostExecuteHandler,
  createTurnStoppingHandler,
  createTurnEndReconciler,
  registerListeners,
  type FirehoseEvent,
  type FirehoseSession,
  type GateDeps,
  type ReconcileDeps,
} from './wiring.ts'
export {
  computeUnmatched,
  evaluateTurnStopping,
  maybeResolveOnReceipt,
  spentCycles,
  findJudgedMessage,
  isTopLevel,
  isTopLevelSession,
  suppressedByOwnNudge,
  windowStartIndex,
  type EvalAgent,
  type EvalEvent,
  type EvalOutcome,
  type EvalSession,
  type EnforceMirrorEntry,
  type EvaluateDeps,
  type UnmatchedComputation,
  type WindowAnchor,
} from './evaluate.ts'

/** Cordis plugin id. */
export const name = 'cc-completion-gate'

/**
 * Mount the plugin: register the settings namespace and the listeners
 * (`tools/post-execute`, the `session/event` observer with the `turn/end`
 * reconciliation, and `agent/turn-stopping`). Plain plugin — no Service, no
 * isolate key.
 * @param ctx - the plug context.
 */
export function apply(ctx: Context): void {
  registerSettings(ctx)
  registerListeners(ctx)
}
