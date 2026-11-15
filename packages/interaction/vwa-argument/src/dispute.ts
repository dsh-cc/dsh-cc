/**
 * Feature D §6.1/§6.2 (docs/plans/2026-11-15-vwa-autonomous-render-pipeline.md):
 * the ONE canonical dispute resolver, used by evaluation, adjudication lookup
 * and liveness.
 *
 * A dispute is identified by content, not by a run: the id derives from
 * `{inputHash, stage}` only. `inputHash` already encodes the task's target refs
 * and dependency identity (§11.3 cache key), while the review records carry
 * `targetRefs` rather than `targetIds` and support/argument tasks use wider
 * sets — so the target set is recovered from the persisted finding instead of
 * entering the id, which keeps the id independent of that difference.
 *
 * Liveness (§6.2) is the ORIGIN-run cohort: a record saved from the cache keeps
 * the run that produced the judgment (`originRunId`), so routine reuse never
 * looks like a new judgment and cannot expire a human decision. The cohort is
 * therefore immutable under reuse and changes only when a genuinely fresh
 * judgment joins the same `{inputHash, stage}`.
 *
 * The TLA model `specs/tla/vwa-adjudication-durability` pins this algebra:
 * `disputeId` is a pure function of `{inputHash, stage}`, `ReuseJudgment` leaves
 * the cohort fixed, and a decision is live only while its recorded cohort still
 * equals the current one.
 *
 * @module @dsh-cc/vwa-argument/dispute
 */
import { sha256Hex, stableJson } from './schema.ts'
import { VwaFail, fail } from './store.ts'
import type { Hash, Id, ProjectSnapshot, ReviewRecord, ReviewStage } from './types.ts'

const DISPUTE_ID_PREFIX = 'finding_dis_'
const DISAGREEMENT_CODE = 'REVIEWER_DISAGREEMENT'

/**
 * One resolved dispute: the content-derived identity plus the two facts liveness
 * needs — the target set the human sees and the cohort the decision was made
 * against.
 */
export interface Dispute {
  /** 'finding_dis_' + sha256(stableJson({inputHash, stage})).slice(0,16) */
  disputeId: Id
  /** The review task cache key (review-runner.ts `inputHash`). */
  inputHash: Hash
  stage: ReviewStage
  /** Recovered from the persisted finding's targetIds, sorted. */
  targetIds: Id[]
  /** Sorted origin-run cohort (§6.2): the runs that PRODUCED a judgment. */
  originRunIds: Id[]
}

/** §6.1: the dispute id is content-derived, so re-evaluation can never re-mint it. */
export function disputeId(inputHash: Hash, stage: ReviewStage): Id {
  return `${DISPUTE_ID_PREFIX}${sha256Hex(stableJson({ inputHash, stage })).slice(0, 16)}`
}

/** The run that produced a record's judgment: a cache reuse carries it explicitly. */
export function originOf(record: ReviewRecord): Id {
  return record.originRunId ?? record.runId
}

function groupKey(stage: ReviewStage, inputHash: Hash): string {
  return `${stage}\u0000${inputHash}`
}

/**
 * §6.1: resolve every persisted dispute in one record store.
 *
 * A dispute requires a persisted disagreement marker (that is the finding a
 * human adjudicates) and takes its cohort from the ORIGIN runs of the completed
 * judgments over the same `{inputHash, stage}` (§6.2).
 *
 * Duplicate `disputeId`s are an error, never a merge: truncation to 16 hex
 * chars is not claimed to be injective, so the runtime check is the guarantee.
 */
export function resolveDisputes(snapshot: ProjectSnapshot, records: ReviewRecord[]): Dispute[] {
  const cohorts = new Map<string, Set<Id>>()
  const markers: { inputHash: Hash; stage: ReviewStage; targetIds: Id[] }[] = []
  for (const record of records) {
    // 'extract'/'align' are the audit sub-stages: audit findings are never
    // reviewer disagreements and are adjudicated on their own identity.
    if (record.stage === 'extract' || record.stage === 'align') continue
    const stage: ReviewStage = record.stage
    for (const finding of record.response?.findings ?? [])
      if (finding.code === DISAGREEMENT_CODE)
        markers.push({ inputHash: record.inputHash, stage, targetIds: [...new Set(finding.targetIds)].sort() })
    // Only completed judgments carry provenance. A marker copy is not an
    // independent judgment, but it records the DETECTING run as its origin — the
    // same run its own record contributes — so counting it cannot widen the
    // cohort, and it keeps the cohort honest if the plain record is pruned.
    if (record.status !== 'completed' || record.response === undefined) continue
    const key = groupKey(stage, record.inputHash)
    const cohort = cohorts.get(key) ?? new Set<Id>()
    cohort.add(originOf(record))
    cohorts.set(key, cohort)
  }
  const resolved = new Map<Id, Dispute>()
  for (const marker of markers) {
    const id = disputeId(marker.inputHash, marker.stage)
    const prior = resolved.get(id)
    if (prior !== undefined) {
      if (
        prior.inputHash !== marker.inputHash ||
        prior.stage !== marker.stage ||
        stableJson(prior.targetIds) !== stableJson(marker.targetIds)
      )
        throw new VwaFail(
          fail(
            'SCHEMA_INVALID',
            `duplicate disputeId ${id} in project ${snapshot.projectId}: ${prior.stage}/${prior.inputHash} and ${marker.stage}/${marker.inputHash} resolve to the same id; repair the review records`,
          ),
        )
      // The same dispute seen twice (a re-run re-persisted the marker).
      continue
    }
    resolved.set(id, {
      disputeId: id,
      inputHash: marker.inputHash,
      stage: marker.stage,
      targetIds: marker.targetIds,
      originRunIds: [...(cohorts.get(groupKey(marker.stage, marker.inputHash)) ?? [])].sort(),
    })
  }
  return [...resolved.values()].sort((a, b) => a.disputeId.localeCompare(b.disputeId))
}
