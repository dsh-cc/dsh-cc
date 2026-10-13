/**
 * @dsh-cc/vwa-evidence — Verifiable Workspace Agent evidence substrate
 * (design docs/plans/2026-10-12-verifiable-workspace-agent.md §4).
 *
 * Pure-function core: marker/claim extraction, mechanical read-back
 * verification, the three document gates, receipt writes, and the
 * per-artifact pipeline. Turn-stopping wiring, artifact-set derivation,
 * settings registration and nudge limits are P2b's job.
 *
 * @module @dsh-cc/vwa-evidence
 */

export { encodeSegment } from './encode.ts'
export {
  nudgeBudgetConsumed,
  receiptLedgerPath,
  sha256Hex,
  stableJson,
  staleAgainst,
  writeReceipt,
  type ClaimEntry,
  type ClaimStatus,
  type GateEntry,
  type GateStatus,
  type NumberEntry,
  type ReceiptRow,
  type WriteReceiptResult,
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
  type VwaEvidenceSettings,
} from './settings.ts'
