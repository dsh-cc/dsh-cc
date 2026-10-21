/**
 * F1.2 (design docs/plans/2026-10-21-vwa-feasibility-runtime-alignment.md):
 * runner-side audit reuse in continue mode. When the post-semantic-stage
 * audit input hash still matches a completed, disagreement-free pair from
 * history, the pair is re-persisted under the current run with zero-token
 * usage rows and the outcome is reconstructed from the records — skipping
 * the dispatch. Default (non-continue) mode never reuses: a fresh request
 * is a second opinion by contract.
 *
 * @module @dsh-cc/vwa-argument/audit-reuse-apply
 */
import { findReusableAudit, auditInputHash, effectiveAuditUnitChars } from './audit-reuse.ts'
import { auditOutcomeFromRecords } from './audit.ts'
import type { ReviewRunStore } from './review-run-store.ts'
import type { ExtractionRecord, Hash, Id, ProjectSnapshot, ReviewRecord } from './types.ts'

/** Outcome fields the runner applies when a reused audit replaces dispatch. */
export interface ReusedAuditOutcome {
  findings: ReturnType<typeof auditOutcomeFromRecords>['findings']
  newClaimProposals: ReturnType<typeof auditOutcomeFromRecords>['newClaimProposals']
  metrics: ReturnType<typeof auditOutcomeFromRecords>['metrics']
  needsReview: boolean
  /** Belt-and-suspenders: needs-review new-core from the source run's outcome. */
  newCoreDiscovered: boolean
}

/**
 * Find and apply a reusable audit for a continue-mode run. Returns undefined
 * (and changes nothing) when no eligible pair exists under the current input
 * hash. `records` is the post-semantic-stage judgment set the audit branch
 * already computed; `seq` is the run's current call counter (§A.3.5 rows).
 */
export function applyReusedAudit(input: {
  history: (ReviewRecord & { kind?: 'disagreement' })[]
  snapshot: ProjectSnapshot
  artifact: { id: Id; text: string }
  records: ReviewRecord[]
  frozenCore: Iterable<Id>
  contractHash: Hash
  configHash: Hash
  /** May be undefined; effectiveAuditUnitChars applies the runner defaults. */
  maxUnitChars: number | undefined
  maxContextChars: number | undefined
  runId: Id
  seq: number
  save: (record: ReviewRecord) => void
  store: ReviewRunStore
}): ReusedAuditOutcome | undefined {
  const reusable = findReusableAudit(
    input.history,
    auditInputHash({
      snapshot: input.snapshot,
      artifact: input.artifact,
      records: input.records,
      coreClaimIds: [...input.frozenCore],
      contractHash: input.contractHash,
      reviewerConfigHash: input.configHash,
      unitChars: effectiveAuditUnitChars({
        ...(input.maxUnitChars === undefined ? {} : { maxUnitChars: input.maxUnitChars }),
        ...(input.maxContextChars === undefined ? {} : { maxContextChars: input.maxContextChars }),
      }),
    }),
  )
  if (reusable === undefined) return undefined
  // Belt-and-suspenders: needs-review new-core lives in the source run's
  // outcome (the align record's coreClaimIds only unions mapped claim ids),
  // so it must carry into the reused outcome.
  const sourceOutcome = input.store.readOutcome(reusable.align.runId) as { newCoreDiscovered?: boolean } | undefined
  input.save({ ...reusable.extract, runId: input.runId })
  input.save({ ...reusable.align, runId: input.runId })
  // §A.3.5: reused records appear in the ledger with zero tokens.
  for (const reusedStage of ['extract', 'align'] as const)
    input.store.appendUsage(input.runId, {
      runId: input.runId,
      taskId: reusedStage,
      seq: input.seq,
      kind: 'reused',
      inputTokens: 0,
      outputTokens: 0,
      method: 'tokenizer',
    })
  const reused = auditOutcomeFromRecords(
    { ...reusable.extract, runId: input.runId } as ExtractionRecord,
    { ...reusable.align, runId: input.runId },
    [...input.frozenCore],
  )
  return {
    findings: reused.findings,
    newClaimProposals: reused.newClaimProposals,
    metrics: reused.metrics,
    needsReview: reused.needsReview,
    newCoreDiscovered: sourceOutcome?.newCoreDiscovered === true,
  }
}
