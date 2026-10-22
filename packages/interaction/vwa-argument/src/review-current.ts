/** Select current, fully covered review tasks; history never becomes current by recency alone. */
import { buildReverseIndex } from './dependencies.ts'
import { sha256Hex, stableJson, validateReviewResponse } from './schema.ts'
import { policyHash, promptHash, recordMatchesKey, semanticContract, semanticContractHash } from './review-contract.ts'
import { planStage, type ReviewStage, type ReviewTask } from './review-plan.ts'
import { deduplicateBySemanticHash, semanticRecordHash, taskDependencyDigest } from './review-input.ts'
import { cacheKey, detectDisagreement, disagreementFinding } from './review-run-store.ts'
import type { Finding, Hash, Id, ProjectSnapshot, ReviewRecord, Verdict } from './types.ts'

/** Shared task identity for delivery and progress, including scope-dependent rules. */
export function matchesReviewTask(
  r: ReviewRecord,
  task: ReviewTask,
  expected: { contractHash: Hash; dependencyDigest: Hash; reviewerConfigHash?: Hash },
): boolean {
  return r.stage === task.stage &&
    r.contractHash === expected.contractHash &&
    r.policyHash === policyHash() &&
    r.promptHash === promptHash(task.stage) &&
    (expected.reviewerConfigHash === undefined || r.reviewerConfigHash === expected.reviewerConfigHash) &&
    r.dependencyDigest === expected.dependencyDigest &&
    stableJson(r.targetRefs) === stableJson(task.targetRefs) &&
    // F3.1: key comparison goes through the one shared matcher.
    recordMatchesKey(
      r,
      cacheKey({
        stage: task.stage, targetRefs: task.targetRefs, requiredRules: task.requiredRules,
        dependencyDigest: expected.dependencyDigest, contractHash: expected.contractHash,
        policyHash: policyHash(), reviewerConfigHash: r.reviewerConfigHash, promptHash: promptHash(task.stage),
      }),
    )
}

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
  const contractHash = semanticContractHash(snapshot.contract)
  for (const stage of ['sources', 'support', 'claims', 'arguments'] as const) {
    const tasks = planStage({ stage, snapshot, index, targetClaimIds: targets, core: new Set(), claimsBatchSize: snapshot.contract.reviewSettings?.claimsBatchSize ?? 1 })
    const verdicts: Verdict[] = []
    for (const task of tasks) {
      const expected = taskDependencyDigest(index, task, records)
      const candidates = all.filter(
        (r): r is import('./types.ts').SemanticReviewRecord =>
          r.stage !== 'extract' && matchesReviewTask(r, task, {
            contractHash, dependencyDigest: expected,
            ...(reviewer === undefined ? {} : { reviewerConfigHash: reviewer }),
          }),
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
      if (planStage({ stage, snapshot, index, targetClaimIds: targets, core: new Set(), claimsBatchSize: snapshot.contract.reviewSettings?.claimsBatchSize ?? 1 }).length === 0)
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
      // F3.1: audit identity uses the semantic contract (capacity excluded).
      contract: semanticContract(snapshot.contract),
      graph: [...index.claims.values()],
      groups: snapshot.groups,
      arguments: snapshot.arguments,
      issues: snapshot.issues,
      // Alignment receives all search logs, including project-wide searches
      // outside semantic task dependencies. Both reuse and delivery must
      // invalidate when these model-visible inputs change.
      searches: snapshot.searches,
      upstream: deduplicateBySemanticHash(
        records.filter((r) => ['sources', 'support', 'claims', 'arguments'].includes(r.stage)),
      )
        .map(semanticRecordHash)
        .sort(),
    }),
  )
}
/** Stage families require every applicable member, rather than any completed call. */
export function stageFamily(stages: CurrentReviews['stages'], names: ReviewStage[]): Verdict {
  return combineVerdicts(names.map((s) => stages[s as keyof CurrentReviews['stages']]))
}
