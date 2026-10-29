/** Pure delivery-only copies: the review ledger remains historical evidence. */
import type { AdjudicationRecord, Id, ReviewRecord } from './types.ts'

export function effectiveReviewRecords(
  records: ReviewRecord[],
  adjudications: AdjudicationRecord[],
  excludedMarkerIds: ReadonlySet<Id>,
): ReviewRecord[] {
  const rejected = new Set(adjudications.filter((a) => a.decision === 'reject').map((a) => a.findingId))
  // Marker responses copy one detecting judgment. They are not independent
  // judgments and must not reintroduce a superseded verdict under another run.
  const effective = structuredClone(records.filter((r) => r.kind !== 'disagreement'))
  for (const record of effective) {
    if (record.stage === 'extract' || !record.response) continue
    const superseded = adjudications.filter((a) => a.overrides.supersededRunId === record.runId)
    for (const target of record.response.targets)
      for (const check of target.checks) {
        const rejectedRule = adjudications.some(
          (a) =>
            a.decision === 'reject' && a.overrides.runId === record.runId &&
            a.overrides.ruleId === check.ruleId &&
            record.response?.findings.some((f) => f.id === a.findingId && f.targetIds.includes(target.targetId)) &&
            !record.response?.findings.some(
              (f) => f.code === check.ruleId && f.targetIds.includes(target.targetId) && !rejected.has(f.id),
            ),
        )
        if (rejectedRule || superseded.some(
          (a) => a.overrides.ruleId === check.ruleId && a.overrides.targetId === target.targetId,
        )) check.result = 'pass'
      }
    record.response.findings = record.response.findings.flatMap((finding) => {
      if (rejected.has(finding.id) || excludedMarkerIds.has(finding.id)) return []
      const targetIds = finding.targetIds.filter((targetId) => !superseded.some(
        (a) => a.overrides.ruleId === finding.code && a.overrides.targetId === targetId,
      ))
      // A batched finding retains its force for every non-superseded target.
      return targetIds.length || finding.targetIds.length === 0 ? [{ ...finding, targetIds }] : []
    })
  }
  return effective
}
