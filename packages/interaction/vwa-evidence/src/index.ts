/**
 * @dsh-cc/vwa-evidence — Verifiable Workspace Agent evidence substrate
 * (design docs/plans/2026-10-12-verifiable-workspace-agent.md §4).
 *
 * Pure-function core (marker/claim extraction, mechanical read-back
 * verification, the three document gates, receipt writes, the per-artifact
 * pipeline) plus the P2b plugin face: the turn-stopping evaluator (window
 * anchoring, artifact-set derivation, pending-recovery replay, nudge
 * budgets), the settings hot-read, and the cordis mounting.
 *
 * Plain plugin (not a Service): `apply(ctx)` with `inject = ['shell']`
 * (post-edit-verify idiom, §4.3 gate C seam). Mounted ONLY in
 * agent.vwa.cordis.yml — the cc preset deliberately lacks the row, so cc
 * sessions stay untouched (§4.4).
 *
 * Sole-writer rule (§4.1): the turn-stopping evaluator is the only writer of
 * the `<dshHome>/vwa-receipts/` ledger.
 *
 * @module @dsh-cc/vwa-evidence
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { registerSettings } from './settings.ts'
import { registerEvaluator } from './wiring.ts'

export { encodeSegment } from './encode.ts'
export {
  isV1Row,
  isV2Row,
  lastV2ReceiptHash,
  nudgeBudgetConsumed,
  receiptHashOf,
  receiptLedgerPath,
  sha256Hex,
  stableJson,
  staleAgainst,
  writeReceipt,
  writeReceiptV2,
  type AnyReceiptRow,
  type AssessmentEntry,
  type ClaimEntry,
  type ClaimStatus,
  type GateEntry,
  type GateStatus,
  type MechanicalStatus,
  type NumberEntry,
  type ReceiptClaim,
  type ReceiptRow,
  type ReceiptV2,
  type Verdict,
  type WriteReceiptResult,
  type WriteReceiptV2Result,
} from './receipt.ts'
export {
  CLAIM_DETECTORS,
  IDENTIFIER_DETECTORS,
  MARKER_CLOSE,
  MARKER_OPEN,
  extractClaims,
  findMarkers,
  parseMarkerInner,
  proseMask,
  type Extraction,
  type MarkerOccurrence,
  type SourceSpec,
} from './marker.ts'
export { isWhitelistedRel, verifyClaim, verifySpec, type VerifyOutcome, type VerifyOptions } from './verify.ts'
export {
  DEFAULT_GATE_TIMEOUT_MS,
  gateBStyle,
  runGates,
  type Executor,
  type GateOptions,
} from './gates.ts'
export { evaluateArtifact, type EvaluationResult, type EvaluateOptions } from './pipeline.ts'
export {
  DEFAULT_VWA_EVIDENCE_SETTINGS,
  SETTINGS_NAMESPACE,
  SettingsSchema,
  readUserSettingsSync,
  registerSettings,
  type VwaEvidenceSettings,
} from './settings.ts'
export {
  deliveryState,
  boundNudgeTargets,
  buildReceiptV2,
  presentedFiles,
  readCurrentProject,
  resolveDeliveryProvider,
  overallOf,
  writeBoundReport,
  type AssessmentLike,
  type DeliveryCheckLike,
  type FindingLike,
  type VwaArgumentDeliveryProvider,
} from './vwa-delivery.ts'
export {
  VWA_EVIDENCE_SOURCE_KIND,
  createEvaluatorState,
  editedPathOf,
  editedPaths,
  evaluateTurnStopping,
  findJudgedMessage,
  isGenuineUser,
  windowStartIndex,
  type EvalAgent,
  type EvalEvent,
  type EvalSession,
  type EvaluatorState,
  type TurnOutcome,
} from './evaluator.ts'
export {
  createTurnStoppingHandler,
  registerEvaluator,
  shellExecutorOf,
  type VwaDeps,
} from './wiring.ts'

/** Cordis plugin id (mount-row name `@dsh-cc/vwa-evidence`). */
export const name = 'vwa-evidence'

/**
 * Every cordis service this plugin touches: gate C runs through the harness
 * ShellExecutor (§4.3, post-edit-verify seam). Regression-pinned by tests.
 */
export const inject = ['shell']

/**
 * Mount the plugin: register the settings namespace (UX-only — the listener
 * hot-reads the raw user file per dispatch, §4.4), then the turn-stopping
 * listener. Inert without `dshHome` (nothing durable to write).
 * @param ctx - the plug context.
 */
export function apply(ctx: Context): void {
  registerSettings(ctx)
  let shell: ShellExecutor | undefined
  try {
    shell = ctx.get('shell') as ShellExecutor | undefined
  } catch {
    shell = undefined
  }
  if (shell === undefined) {
    ctx.logger.warn('vwa-evidence: no shell service on the host context; gate C will abstain')
  }
  registerEvaluator(ctx, shell)
}
