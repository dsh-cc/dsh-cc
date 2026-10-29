/**
 * The `/vwa adjudicate` transaction (design docs/plans/2026-10-16-… §18 and
 * docs/plans/2026-10-28-vwa-batch-autonomous-review.md §4.4): semantic
 * findings only (deterministic failures cannot be overridden); a disagreement
 * requires the human to name which of the two conflicting runs prevails.
 *
 * @module @dsh-cc/vwa-argument/adjudicate
 */
import { randomUUID } from 'node:crypto'
import { appendAdjudication, currentDependencyDigest, readReviewRecords } from './report.ts'
import type { AdjudicationRecord, Finding, Id } from './types.ts'
import type { CommandResult } from '@deepseek-ai/dsh-commands'

/** Deterministic failures (path/hash/quote mismatch) can never be adjudicated away (§18). */
const DETERMINISTIC_FINDING_PREFIXES = ['MECH', 'EVID-01', 'HIST-04']

function isDeterministicFinding(finding: Finding): boolean {
  return DETERMINISTIC_FINDING_PREFIXES.some((prefix) => finding.code.startsWith(prefix))
}

/** Find one finding by id across all completed review records. */
export function findFinding(
  root: string,
  projectId: string,
  findingId: string,
): (Finding & { kind?: string; runId?: string }) | undefined {
  for (const record of readReviewRecords(root, projectId)) {
    const finding =
      record.stage === 'extract' ? undefined : record.response?.findings.find((candidate) => candidate.id === findingId)
    if (finding !== undefined) return { ...finding, runId: record.runId }
  }
  return undefined
}

/**
 * §4.4: the two (or more) runs whose identical inputs produced differing
 * verdicts for this disagreement marker (same stage + inputHash).
 */
export function conflictingRunIds(root: string, projectId: string, findingId: string): Id[] {
  return conflictingRecords(root, projectId, findingId).map((record) => record.runId)
}

function conflictingRecords(root: string, projectId: string, findingId: string) {
  const records = readReviewRecords(root, projectId)
  const home = records.find(
    (record) => record.stage !== 'extract' && record.response?.findings.some((f) => f.id === findingId),
  )
  if (home === undefined || home.stage === 'extract') return []
  return [
    ...new Map(
      records
        .filter(
          (record) =>
            record.stage === home.stage &&
            record.status === 'completed' &&
            record.response !== undefined &&
            // The marker copy is not a conflicting verdict.
            (record as { kind?: string }).kind !== 'disagreement' &&
            record.inputHash === home.inputHash,
        )
        .map((record) => [record.runId, record]),
    ).values(),
  ]
}

/**
 * The (targetId, ruleId) slot whose verdicts actually differ between the
 * conflicting records — the slot an adjudication overrides (§4.4).
 */
function conflictingSlot(
  root: string,
  projectId: string,
  findingId: string,
): { ruleId: string; targetId: Id } | undefined {
  const records = conflictingRecords(root, projectId, findingId)
  const home = readReviewRecords(root, projectId).find(
    (record) => record.stage !== 'extract' && record.response?.findings.some((f) => f.id === findingId),
  )
  if (home === undefined || home.stage === 'extract' || home.response === undefined) return undefined
  const verdicts = new Map<string, string>()
  const slots = new Map<string, { ruleId: string; targetId: Id }>()
  for (const target of home.response.targets)
    for (const check of target.checks) {
      const key = `${target.targetId}|${check.ruleId}`
      verdicts.set(key, check.result)
      slots.set(key, { ruleId: check.ruleId, targetId: target.targetId })
    }
  for (const record of records.slice(1)) {
    if (record.stage === 'extract' || record.response === undefined) continue
    for (const target of record.response.targets)
      for (const check of target.checks) {
        const key = `${target.targetId}|${check.ruleId}`
        if (verdicts.has(key) && verdicts.get(key) !== check.result) return slots.get(key)
      }
  }
  return undefined
}

/**
 * The /vwa adjudicate transaction (§18, §4.4). `prevailingRunId` is required
 * for a REVIEWER_DISAGREEMENT (validated against its conflicting runs) and
 * optional for legacy single-run findings.
 */
export async function vwaAdjudicate(
  root: string,
  projectId: string,
  findingId: string,
  decision: 'accept' | 'reject',
  reason: string,
  prevailingRunId?: string,
): Promise<CommandResult> {
  if (reason.trim() === '') {
    return { kind: 'error', text: 'adjudication requires a non-empty reason (§18).' }
  }
  const finding = findFinding(root, projectId, findingId)
  if (finding === undefined) {
    return { kind: 'error', text: `finding "${findingId}" not found among this project's review records.` }
  }
  if (isDeterministicFinding(finding)) {
    return {
      kind: 'error',
      text: `finding ${findingId} (${finding.code}) is a deterministic failure (path/hash/quote); it cannot be overridden by adjudication.`,
    }
  }
  let runId = finding.runId ?? ''
  let supersededRunId: Id | undefined
  let slot: { ruleId: string; targetId: Id } | undefined
  if (finding.code === 'REVIEWER_DISAGREEMENT') {
    const runs = conflictingRunIds(root, projectId, findingId)
    if (runs.length < 2) {
      return {
        kind: 'error',
        text: `finding ${findingId} is a reviewer disagreement, but its two conflicting current runs are not readable; re-run the review or repair the store.`,
      }
    }
    if (prevailingRunId === undefined || !runs.includes(prevailingRunId)) {
      return {
        kind: 'error',
        text: `prevailingRunId must be one of the disagreeing runs (${runs.join(', ')}).`,
      }
    }
    runId = prevailingRunId
    supersededRunId = runs.find((candidate) => candidate !== prevailingRunId)
    slot = conflictingSlot(root, projectId, findingId)
  } else if (prevailingRunId !== undefined && prevailingRunId !== runId) {
    return {
      kind: 'error',
      text: `prevailingRunId ${prevailingRunId} is not the run that produced finding ${findingId} (${runId}).`,
    }
  }
  const dependencyDigest = currentDependencyDigest(root, projectId)
  if (dependencyDigest === undefined) {
    return { kind: 'error', text: 'cannot read the project HEAD; repair the store first (/vwa repair).' }
  }
  const record: AdjudicationRecord = {
    adjudicationId: `adj_${randomUUID()}`,
    findingId,
    decision,
    reason: reason.trim(),
    signer: 'user',
    ts: new Date().toISOString(),
    dependencyDigest,
    overrides: {
      ruleId: slot?.ruleId ?? finding.code,
      targetId: slot?.targetId ?? finding.targetIds[0] ?? '',
      runId,
      ...(supersededRunId === undefined ? {} : { supersededRunId }),
    },
  }
  appendAdjudication(root, projectId, record)
  const effect =
    decision === 'reject'
      ? 'The finding is removed from the active set and the rule shows pass (human-adjudicated); grades are recomputed by policy on the next checkForDelivery. The original review record is NOT rewritten.'
      : 'The finding stays active and still needs fixing (accept is not ignore).'
  return {
    kind: 'success',
    text: `Adjudication ${record.adjudicationId} recorded: ${decision} ${findingId}. ${effect}`,
  }
}
