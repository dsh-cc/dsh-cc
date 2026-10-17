/**
 * Review stage planning (design docs/plans/2026-10-16-vwa-evidence-argument.md
 * §11.1, §11.3, §8.2 applicability matrix, §12.1 core set).
 *
 * Fine-grained tasks (§11.3): sources by source, support by group (a task
 * always carries the COMPLETE group — joint evidence is never split), claims
 * per applicable claim EXACTLY ONCE (type rules + search sufficiency, owned
 * by the claims stage, independent of arguments), arguments per argument
 * plus issue tasks with targets. Issues are reviewed with their targets.
 *
 * The effective core set is frozen at review-plan creation (§12.1): core =
 * author-marked core ∪ plan-time extraction findings (slice-4 input, empty
 * here) ∪ claims located in the title/abstract/conclusion sections ∪ claims
 * answering requiredQuestions.
 *
 * @module @dsh-cc/vwa-argument/review-plan
 */

import type { ReverseIndex } from './dependencies.ts'
import { randomUUID } from 'node:crypto'
import type { Id, ProjectSnapshot, Ref } from './types.ts'

export type ReviewStage = 'sources' | 'support' | 'claims' | 'arguments'

/** One planned per-stage review task (§11.1/§11.3). */
export interface ReviewTask {
  taskId: string
  stage: ReviewStage
  targetRefs: Ref[]
  /** Ids the model may reference as targets (closure of the task's inputs). */
  targetIds: Id[]
  /** §8.2 required checks per target id. */
  requiredRules: { targetId: Id; ruleId: string }[]
  /** Serialized §11.4 envelope payload (contract, targets, dependencies, budget). */
  envelope: unknown
}

/** Claims in the dependency closure of the review targets (§10.6 expansion). */
export function claimClosure(index: ReverseIndex, targetClaimIds: Id[]): Set<Id> {
  const closure = new Set<Id>()
  const visit = (claimId: Id): void => {
    if (closure.has(claimId)) return
    closure.add(claimId)
    for (const argument of index.arguments.values()) {
      if (argument.premiseClaimIds.includes(claimId)) visit(argument.conclusionClaimId)
    }
  }
  for (const id of targetClaimIds) visit(id)
  return closure
}

/** Evidence of the groups targeting the closure claims, grouped per group. */
function groupsOfClaims(index: ReverseIndex, claims: ReadonlySet<Id>): Map<Id, { groupIds: Id[]; evidenceIds: Id[]; sourceIds: Id[] }> {
  const out = new Map<Id, { groupIds: Id[]; evidenceIds: Id[]; sourceIds: Id[] }>()
  const ensure = (claimId: Id) => {
    let entry = out.get(claimId)
    if (entry === undefined) {
      entry = { groupIds: [], evidenceIds: [], sourceIds: [] }
      out.set(claimId, entry)
    }
    return entry
  }
  for (const group of index.groups.values()) {
    if (!claims.has(group.targetClaimId)) continue
    const entry = ensure(group.targetClaimId)
    entry.groupIds.push(group.id)
    for (const evidenceId of group.evidenceIds) {
      entry.evidenceIds.push(evidenceId)
      const sourceId = index.evidence.get(evidenceId)?.sourceId
      if (sourceId !== undefined) entry.sourceIds.push(sourceId)
    }
  }
  return out
}

/**
 * §12.1 core set frozen at plan creation. Section rules (§9): title = first
 * ATX-1 heading block; abstract = section matching /^摘要|abstract$/i;
 * conclusion = LAST ATX-2+ section matching /结论|conclusion|结语/i; plus
 * outline goal sections answering requiredQuestions. Extracted-core findings
 * from the audit stage are accepted as an extra input (slice-4 seam).
 *
 * ponytail: block segmentation is a blank-line split with ATX-heading
 * detection, not a CommonMark AST — lists with blank lines and HTML blocks
 * may segment differently. Upgrade path: swap `rootBlocks` for a CommonMark
 * parser in the audit slice (P3) without changing the signature.
 */
export function rootBlocks(text: string): { start: number; end: number; heading: { level: number; text: string } | undefined; body: string }[] {
  const blocks: { start: number; end: number; heading: { level: number; text: string } | undefined; body: string }[] = []
  const re = /\n\s*\n/g
  let from = 0
  const push = (end: number): void => {
    const chunk = text.slice(from, end)
    const first = chunk.split('\n', 1)[0] ?? ''
    const heading = /^(#{1,6})\s+(.*)$/.exec(first)
    blocks.push({
      start: from, end,
      heading: heading === null ? undefined : { level: heading[1]!.length, text: heading[2] ?? '' },
      body: chunk,
    })
  }
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    push(match.index)
    from = match.index + match[0].length
  }
  if (from < text.length) push(text.length)
  return blocks
}

export function computeCoreSet(input: {
  index: ReverseIndex
  artifactText: string
  requiredQuestionTexts: readonly string[]
  /** Plan-time extraction findings mapped claimId → spans (slice-4 seam; empty until P3). */
  extractionCoreClaimIds?: readonly Id[]
}): Set<Id> {
  const core = new Set<Id>()
  for (const id of input.extractionCoreClaimIds ?? []) core.add(id)
  const blocks = rootBlocks(input.artifactText)
  const firstHeading1 = blocks.findIndex((b) => b.heading?.level === 1)
  const abstractRe = /^摘要|abstract$/i
  const conclusionRe = /结论|conclusion|结语/i
  let lastConclusion = -1
  for (let i = 0; i < blocks.length; i += 1) {
    const heading = blocks[i]?.heading
    if (heading === undefined) continue
    if (heading.level >= 2 && conclusionRe.test(heading.text)) lastConclusion = i
  }
  const sectionClaims = (blockIndex: number): void => {
    if (blockIndex < 0) return
    for (const occurrenceClaimId of sectionOccurrenceClaims(input.index, blocks, blockIndex)) core.add(occurrenceClaimId)
  }

  sectionClaims(firstHeading1)
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i]?.heading !== undefined && abstractRe.test(blocks[i]!.heading!.text)) sectionClaims(i)
  }
  sectionClaims(lastConclusion)
  // Claims whose outline goal sections answer requiredQuestions (§12.1).
  for (const claim of input.index.claims.values()) {
    if (input.requiredQuestionTexts.some((q) => claim.text.includes(q) || q.includes(claim.text))) core.add(claim.id)
  }
  for (const claim of input.index.claims.values()) {
    if (claim.importance === 'core') core.add(claim.id)
  }
  return core
}

/** Occurrence→claim mapping for one block span (occurrences are hash-watched). */
function sectionOccurrenceClaims(
  index: ReverseIndex,
  blocks: { start: number; end: number }[],
  blockIndex: number,
): Set<Id> {
  const out = new Set<Id>()
  const block = blocks[blockIndex]
  if (block === undefined) return out
  for (const artifact of index.artifacts.values()) {
    for (const occurrence of artifact.occurrences) {
      if (occurrence.span.start >= block.start && occurrence.span.start < block.end) out.add(occurrence.claimId)
    }
  }
  return out
}

/** Plan the tasks of one stage (§11.1 table + §8.2 matrix). */
export function planStage(input: {
  stage: ReviewStage
  snapshot: ProjectSnapshot
  index: ReverseIndex
  targetClaimIds: Id[]
  core: ReadonlySet<Id>
}): ReviewTask[] {
  const claims = claimClosure(input.index, input.targetClaimIds)
  const perClaim = groupsOfClaims(input.index, claims)
  if (input.stage === 'sources') {
    const sourceIds = new Set<Id>()
    for (const entry of perClaim.values()) {
      for (const sourceId of entry.sourceIds) sourceIds.add(sourceId)
    }
    for (const claim of input.snapshot.claims) {
      if (claims.has(claim.id)) for (const sourceId of claim.scope.corpus) sourceIds.add(sourceId)
    }
    return [...sourceIds].map((sourceId) => {
      const rules = ['SOURCE-01', 'SOURCE-02']
      // §8.2: two or more sources for one claim adds SOURCE-03 for those sources.
      for (const entry of perClaim.values()) {
        const sourcesForClaim = new Set(entry.sourceIds)
        for (const claim of input.snapshot.claims) {
          if (claims.has(claim.id)) for (const id of claim.scope.corpus) sourcesForClaim.add(id)
        }
        if (sourcesForClaim.size >= 2 && sourcesForClaim.has(sourceId)) {
          rules.push('SOURCE-03')
          break
        }
      }
      return {
        taskId: `task_${randomUUID()}`,
        stage: 'sources',
        targetRefs: [{ id: sourceId, entityVersion: input.index.sources.get(sourceId)!.entityVersion }],
        targetIds: [sourceId],
        requiredRules: [{ targetId: sourceId, ruleId: rules[0]! }, ...rules.slice(1).map((r) => ({ targetId: sourceId, ruleId: r }))],
        envelope: { target: input.index.sources.get(sourceId) },
      }
    })
  }
  if (input.stage === 'support') {
    const tasks: ReviewTask[] = []
    for (const group of input.index.groups.values()) {
      if (!claims.has(group.targetClaimId)) continue
      const rules = ['EVID-02', 'SUP-01', 'SUP-02']
      tasks.push({
        taskId: `task_${randomUUID()}`,
        stage: 'support',
        targetRefs: [{ id: group.id, entityVersion: group.entityVersion }],
        targetIds: [group.id, ...group.evidenceIds],
        requiredRules: rules.map((ruleId) => ({ targetId: group.id, ruleId })),
        envelope: { target: group, evidence: group.evidenceIds.map((id) => input.index.evidence.get(id)) },
      })
    }
    return tasks
  }
  if (input.stage === 'claims') {
    const typeRule: Record<string, string> = {
      fact: 'HIST-01', 'source-report': 'HIST-01', causal: 'CAUSE-01',
      intent: 'INTENT-01', interpretation: 'INTERP-01', evaluation: 'EVAL-01',
    }
    return input.snapshot.claims
      .filter((claim) => claims.has(claim.id) && typeRule[claim.kind] !== undefined)
      .map((claim) => ({
        taskId: `task_${randomUUID()}`,
        stage: 'claims' as const,
        targetRefs: [{ id: claim.id, entityVersion: claim.entityVersion }],
        targetIds: [claim.id],
        requiredRules: [{ targetId: claim.id, ruleId: typeRule[claim.kind]! }],
        envelope: { target: claim, searches: input.snapshot.searches.filter((s) => s.targetIds.includes(claim.id)) },
      }))
  }
  // arguments: one task per argument, one per issue with a target in scope.
  const tasks: ReviewTask[] = []
  for (const argument of input.index.arguments.values()) {
    if (!claims.has(argument.conclusionClaimId)) continue
    tasks.push({
      taskId: `task_${randomUUID()}`,
      stage: 'arguments',
      targetRefs: [{ id: argument.id, entityVersion: argument.entityVersion }],
      targetIds: [argument.id, ...argument.premiseClaimIds],
      requiredRules: [
        { targetId: argument.id, ruleId: 'ARG-01' },
        { targetId: argument.id, ruleId: 'ARG-02' },
      ],
      envelope: { target: argument, premises: argument.premiseClaimIds.map((id) => input.index.claims.get(id)) },
    })
  }
  for (const issue of input.index.issues.values()) {
    const inScope = claims.has(issue.targetId) || issue.relatedClaimIds.some((id) => claims.has(id))
    if (!inScope) continue
    tasks.push({
      taskId: `task_${randomUUID()}`,
      stage: 'arguments',
      targetRefs: [{ id: issue.id, entityVersion: issue.entityVersion }],
      targetIds: [issue.id],
      requiredRules: [{ targetId: issue.id, ruleId: 'ISSUE-01' }],
      envelope: { target: issue },
    })
  }
  return tasks
}
