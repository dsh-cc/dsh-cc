/** Select current, fully covered review tasks; history never becomes current by recency alone. */
import { buildReverseIndex } from './dependencies.ts'
import { sha256Hex, stableJson, validateReviewResponse } from './schema.ts'
import { policyHash, promptHash } from './review-contract.ts'
import { planStage, type ReviewStage } from './review-plan.ts'
import { taskDependencyDigest } from './review-input.ts'
import { detectDisagreement, disagreementFinding } from './review-run-store.ts'
import type { Finding, Hash, Id, ProjectSnapshot, ReviewRecord, Verdict } from './types.ts'

export interface CurrentReviews {
  records: ReviewRecord[]
  historical: ReviewRecord[]
  findings: Finding[]
  stages: Record<'sources' | 'support' | 'claims' | 'arguments', Verdict>
}
export function currentReviews(
  snapshot: ProjectSnapshot,
  all: ReviewRecord[],
  targets: Id[],
  reviewer?: Hash,
): CurrentReviews {
  const records: ReviewRecord[] = [],
    findings: Finding[] = []
  const stages = {} as CurrentReviews['stages']
  const index = buildReverseIndex(snapshot)
  const contractHash = sha256Hex(stableJson(snapshot.contract))
  for (const stage of ['sources', 'support', 'claims', 'arguments'] as const) {
    const tasks = planStage({ stage, snapshot, index, targetClaimIds: targets, core: new Set() })
    const verdicts: Verdict[] = []
    for (const task of tasks) {
      const expected = taskDependencyDigest(index, task, records)
      const candidates = all.filter(
        (r): r is import('./types.ts').SemanticReviewRecord =>
          r.stage !== 'extract' &&
          r.stage === stage &&
          r.contractHash === contractHash &&
          r.policyHash === policyHash() &&
          r.promptHash === promptHash(stage) &&
          (reviewer === undefined || r.reviewerConfigHash === reviewer) &&
          r.dependencyDigest === expected &&
          stableJson(r.targetRefs) === stableJson(task.targetRefs),
      )
      const valid = candidates.filter(
        (r) => r.status === 'completed' && r.response && validateReviewResponse(r.response),
      )
      const disagreement = detectDisagreement(valid, undefined).disagreement
      if (disagreement) {
        const stored = all.find((r) => r.kind === 'disagreement' && r.inputHash === valid[0]?.inputHash)
        const finding =
          stored && stored.stage !== 'extract'
            ? stored.response?.findings.find((f) => f.code === 'REVIEWER_DISAGREEMENT')
            : undefined
        findings.push(finding ?? disagreementFinding(task.targetIds))
      }
      if (!valid.length) {
        verdicts.push(candidates.length ? 'needs-review' : 'not-run')
        continue
      }
      // Keep every same-input judgment; a newer pass cannot erase an earlier fail.
      records.push(...valid)
      const checks = valid.flatMap((r) => r.response?.targets ?? []).flatMap((t) => t.checks)
      const covered = task.requiredRules.every((rule) =>
        valid.every((r) =>
          r.response?.targets.some(
            (t) => t.targetId === rule.targetId && t.checks.some((c) => c.ruleId === rule.ruleId),
          ),
        ),
      )
      verdicts.push(
        disagreement
          ? 'needs-review'
          : checks.some((c) => c.result === 'fail')
            ? 'fail'
            : !covered || checks.some((c) => c.result === 'needs-review' || c.result === 'not-run')
              ? 'needs-review'
              : 'pass',
      )
    }
    // Empty stages are only inapplicable after at least one current claim type review.
    stages[stage] = verdicts.length
      ? combineVerdicts(verdicts)
      : (
            stage === 'arguments'
              ? stages.claims === 'pass'
              : records.some((r) => r.stage === 'claims' && r.status === 'completed')
          )
        ? 'pass'
        : 'not-run'
  }
  if (stages.claims === 'pass') {
    for (const stage of ['sources', 'support'] as const)
      if (planStage({ stage, snapshot, index, targetClaimIds: targets, core: new Set() }).length === 0)
        stages[stage] = 'pass'
  }
  return { records, historical: all.filter((r) => !records.includes(r)), findings, stages }
}
export function combineVerdicts(verdicts: Verdict[]): Verdict {
  if (verdicts.includes('fail')) return 'fail'
  if (verdicts.includes('needs-review')) return 'needs-review'
  if (!verdicts.length || verdicts.includes('not-run')) return 'not-run'
  return 'pass'
}
export function auditDependencyDigest(snapshot: ProjectSnapshot, artifactId: Id, records: ReviewRecord[]): Hash {
  const artifact = snapshot.artifacts.find((a) => a.id === artifactId)
  const index = buildReverseIndex(snapshot)
  return sha256Hex(
    stableJson({
      artifact: artifact ?? artifactId,
      contract: snapshot.contract,
      graph: [...index.claims.values()],
      groups: snapshot.groups,
      arguments: snapshot.arguments,
      issues: snapshot.issues,
      upstream: records
        .filter((r) => ['sources', 'support', 'claims', 'arguments'].includes(r.stage))
        .map((r) => sha256Hex(stableJson(r)))
        .sort(),
    }),
  )
}
/** Stage families require every applicable member, rather than any completed call. */
export function stageFamily(stages: CurrentReviews['stages'], names: ReviewStage[]): Verdict {
  return combineVerdicts(names.map((s) => stages[s as keyof CurrentReviews['stages']]))
}
