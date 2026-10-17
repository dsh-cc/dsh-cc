/** Complete task inputs and the same dependency identity used at execution and delivery. */
import { buildReverseIndex, dependencyDigest, dependencyEntries, type ReverseIndex } from './dependencies.ts'
import { sha256Hex, stableJson } from './schema.ts'
import { RULES, RUBRIC_VERSION } from './review-contract.ts'
import type { ReviewTask } from './review-plan.ts'
import type { Hash, Id, ProjectSnapshot, ReviewRecord } from './types.ts'

const ORDER = ['sources', 'support', 'claims', 'arguments', 'extract', 'align']
export function taskDependencyIds(index: ReverseIndex, task: ReviewTask): Id[] {
  const ids = new Set(task.targetIds)
  for (const ref of task.targetRefs) {
    const group = index.groups.get(ref.id)
    if (group) ids.add(group.targetClaimId)
    const arg = index.arguments.get(ref.id)
    if (arg) ids.add(arg.conclusionClaimId)
    const issue = index.issues.get(ref.id)
    if (issue) {
      ids.add(issue.targetId)
      issue.relatedClaimIds.forEach((id) => ids.add(id))
    }
    const source = index.sources.get(ref.id)
    if (source) {
      for (const ev of index.evidence.values()) {
        if (ev.sourceId !== source.id) continue
        ids.add(ev.id)
        for (const g of index.groups.values()) if (g.evidenceIds.includes(ev.id)) ids.add(g.targetClaimId)
      }
    }
  }
  return [...ids].sort()
}
export function upstreamRecords(index: ReverseIndex, task: ReviewTask, records: ReviewRecord[]): ReviewRecord[] {
  const ids = new Set(dependencyEntries(index, taskDependencyIds(index, task)).map((e) => e.id))
  return records
    .filter((r) => ORDER.indexOf(r.stage) < ORDER.indexOf(task.stage) && r.targetRefs.some((ref) => ids.has(ref.id)))
    .sort((a, b) => stableJson(a).localeCompare(stableJson(b)))
}
export function taskDependencyDigest(index: ReverseIndex, task: ReviewTask, records: ReviewRecord[]): Hash {
  return sha256Hex(
    stableJson({
      graph: dependencyDigest(index, taskDependencyIds(index, task)),
      task: task.envelope,
      upstream: upstreamRecords(index, task, records)
        .map((r) => sha256Hex(stableJson(r)))
        .sort(),
    }),
  )
}
export function reviewContext(input: {
  snapshot: ProjectSnapshot
  task: ReviewTask
  records: ReviewRecord[]
  readSnapshot?(id: Id): string | undefined
}): unknown {
  const index = buildReverseIndex(input.snapshot)
  const ids = new Set(dependencyEntries(index, taskDependencyIds(index, input.task)).map((e) => e.id))
  const evidence = input.snapshot.evidence.filter((e) => ids.has(e.id))
  const sources = input.snapshot.sources.filter((s) => ids.has(s.id))
  return {
    sources: sources.map((source) => ({
      ...source,
      ...(input.task.stage === 'sources' && input.readSnapshot ? { text: input.readSnapshot(source.id) ?? '' } : {}),
    })),
    evidence: evidence.map((e) => {
      const text = input.readSnapshot?.(e.sourceId)
      return {
        ...e,
        quote: text === undefined ? e.quote : text.slice(e.span.start, e.span.end),
        context: text === undefined ? '' : text.slice(e.contextSpan.start, e.contextSpan.end),
      }
    }),
    claims: input.snapshot.claims.filter((c) => ids.has(c.id)),
    issues: input.snapshot.issues.filter((i) => ids.has(i.id)),
    searches: input.snapshot.searches.filter((s) => ids.has(s.id)),
    currentReviews: upstreamRecords(index, input.task, input.records),
  }
}
export function taskEnvelope(input: {
  stage: string
  runId: Id
  task: ReviewTask
  snapshot: ProjectSnapshot
  records: ReviewRecord[]
  maxOutputTokens: number
  readSnapshot?(id: Id): string | undefined
}): unknown {
  return {
    stage: input.stage,
    runId: input.runId,
    taskId: input.task.taskId,
    rubricVersion: RUBRIC_VERSION,
    requiredRules: input.task.requiredRules,
    ruleDefinitions: Object.fromEntries(input.task.requiredRules.map((r) => [r.ruleId, RULES[r.ruleId]])),
    contract: input.snapshot.contract,
    targets: input.task.targetRefs,
    dependencies: input.task.envelope,
    budget: { maxOutputTokens: input.maxOutputTokens },
    context: reviewContext(input),
  }
}
