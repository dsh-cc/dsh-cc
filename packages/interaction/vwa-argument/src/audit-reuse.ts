/**
 * Audit cache identity and continuation reuse (§A.2, §11.3, §12).
 *
 * An audit (extract + align over one bound artifact) is reusable in continue
 * mode only when every input it was computed from is unchanged: the artifact
 * bytes, the audit dependency digest (graph + current upstream judgments),
 * the frozen core set, the contract, policy, prompts, reviewer config,
 * extraction unit size and result semantics. That identity is the audit
 * records' `inputHash`, so the tool pre-check and the runner guard compare
 * one key and cannot diverge.
 *
 * @module @dsh-cc/vwa-argument/audit-reuse
 */
import { sha256Hex, stableJson } from './schema.ts'
import { auditDependencyDigest } from './review-current.ts'
import { policyHash, promptHash } from './review-contract.ts'
import { recordReusable } from './review-run-store.ts'
import type { Hash, Id, ProjectSnapshot, ReviewRecord } from './types.ts'

export const AUDIT_RULE_IDS = ['AUDIT-01', 'AUDIT-02', 'AUDIT-03', 'AUDIT-04', 'AUDIT-05'] as const

/** Effective extraction unit size: the unit cap, halved context when a caller enforces one. */
export function auditUnitChars(maxUnitChars: number, maxContextChars?: number): number {
  return Math.min(maxUnitChars, maxContextChars === undefined ? maxUnitChars : Math.max(1, Math.floor(maxContextChars / 2)))
}

/** The unit size the runner's audit actually uses (runner defaults: 48k context, unit cap = context). */
export function effectiveAuditUnitChars(opts: { maxUnitChars?: number; maxContextChars?: number }): number {
  const context = opts.maxContextChars ?? 48_000
  return auditUnitChars(opts.maxUnitChars ?? context, context)
}

/** The audit cache key stored as `inputHash` on both the extract and the align record. */
export function auditInputHash(input: {
  snapshot: ProjectSnapshot
  artifact: { id: Id; text: string }
  /** Current upstream judgments the audit sees (deduplicated by semantic hash inside the digest). */
  records: ReviewRecord[]
  coreClaimIds: Iterable<Id>
  contractHash: Hash
  reviewerConfigHash: Hash
  unitChars: number
}): Hash {
  return sha256Hex(
    stableJson({
      stage: 'audit',
      // Legacy records may mix model-emitted AUDIT_* findings with runtime
      // findings. Reconstructing proposals from that order corrupts spans.
      // Invalidate those records in BOTH admission and runner reuse checks;
      // version 2 guarantees that these finding codes are runtime-owned.
      resultVersion: 2,
      artifactHash: sha256Hex(input.artifact.text),
      dependencyDigest: auditDependencyDigest(input.snapshot, input.artifact.id, input.records),
      coreClaimIds: [...new Set(input.coreClaimIds)].sort(),
      contractHash: input.contractHash,
      policyHash: policyHash(),
      reviewerConfigHash: input.reviewerConfigHash,
      promptHashes: { extract: promptHash('extract'), align: promptHash('align') },
      unitChars: input.unitChars,
    }),
  )
}

/**
 * The reusable extract/align pair when history holds a completed, schema-valid
 * pair from ONE run under this audit key. Disagreement markers never qualify.
 */
export function findReusableAudit(
  history: (ReviewRecord & { kind?: 'disagreement' })[],
  inputHash: Hash,
): { extract: ReviewRecord; align: ReviewRecord } | undefined {
  for (const align of history) {
    if (
      align.stage !== 'align' ||
      align.kind === 'disagreement' ||
      align.inputHash !== inputHash ||
      !recordReusable(align, new Set(AUDIT_RULE_IDS))
    )
      continue
    const extract = history.find(
      (r) => r.stage === 'extract' && r.runId === align.runId && r.status === 'completed' && r.inputHash === inputHash,
    )
    if (extract) return { extract, align }
  }
  return undefined
}

export function hasReusableAudit(history: (ReviewRecord & { kind?: 'disagreement' })[], inputHash: Hash): boolean {
  return findReusableAudit(history, inputHash) !== undefined
}
