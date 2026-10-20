/**
 * Reference diagnostics and deletion-closure computation (Feature D, design
 * docs/plans/2026-10-19-vwa-lane2-feature-d-observability-ux.md §D.4).
 *
 * Split out of graph.ts to keep that file under the size cap.
 *
 * @module @dsh-cc/vwa-argument/references
 */

import type { GraphContext } from './graph.ts'
import type { Id } from './types.ts'

/** One concrete reference to an entity: who references it, how, and in which field. */
export interface ReferenceInfo {
  kind: 'source' | 'evidence' | 'claim' | 'group' | 'argument' | 'issue' | 'search' | 'artifact'
  id: Id
  role: string
}

/**
 * Every entity that references `id`, with kind/id/role detail. Same reference
 * categories as graph.ts's label-based findReferences, plus claims whose
 * scope.corpus includes the id.
 */
export function findReferencesDetailed(graph: GraphContext, id: Id): ReferenceInfo[] {
  const snapshot = graph.snapshot
  const refs: ReferenceInfo[] = []
  const note = (kind: ReferenceInfo['kind'], refId: Id, role: string): void => {
    refs.push({ kind, id: refId, role })
  }
  for (const source of snapshot.sources) {
    if (source.lineage.parentSourceIds.includes(id)) note('source', source.id, 'lineage.parentSourceIds')
    if (source.authenticityBasisEvidenceIds.includes(id)) note('source', source.id, 'authenticityBasisEvidenceIds')
  }
  for (const evidence of snapshot.evidence) if (evidence.sourceId === id) note('evidence', evidence.id, 'sourceId')
  for (const claim of snapshot.claims) if (claim.scope.corpus.includes(id)) note('claim', claim.id, 'scope.corpus')
  for (const group of snapshot.groups) {
    if (group.targetClaimId === id) note('group', group.id, 'target')
    if (group.evidenceIds.includes(id)) note('group', group.id, 'evidenceIds')
  }
  for (const argument of snapshot.arguments) {
    if (argument.premiseClaimIds.includes(id)) note('argument', argument.id, 'premiseClaimIds')
    if (argument.conclusionClaimId === id) note('argument', argument.id, 'conclusionClaimId')
    if (argument.evidenceGroupIds.includes(id)) note('argument', argument.id, 'evidenceGroupIds')
  }
  for (const issue of snapshot.issues) {
    if (issue.targetId === id) note('issue', issue.id, 'target')
    if (issue.evidenceIds.includes(id)) note('issue', issue.id, 'evidenceIds')
    if (issue.relatedClaimIds.includes(id)) note('issue', issue.id, 'relatedClaimIds')
  }
  for (const search of snapshot.searches) {
    if (search.targetIds.includes(id)) note('search', search.id, 'targetIds')
    if (search.corpus.includes(id)) note('search', search.id, 'corpus')
    if (search.resultSourceIds.includes(id)) note('search', search.id, 'resultSourceIds')
  }
  for (const artifact of snapshot.artifacts) {
    for (const occurrence of artifact.occurrences) {
      if (occurrence.claimId === id) note('artifact', artifact.id, 'occurrence')
    }
    for (const section of artifact.outline) {
      if (section.claimIds.includes(id)) note('artifact', artifact.id, 'outline.claimIds')
      if (section.argumentIds.includes(id)) note('artifact', artifact.id, 'outline.argumentIds')
    }
  }
  return refs
}

/**
 * Full transitive deletion closure of `rootIds`: every entity the roots
 * reference, recursively. The Set guards cycles (each entity visited once);
 * the returned order is BFS, roots first, so reversal yields leaves-first
 * deletion order.
 */
export function computeDeletionClosure(graph: GraphContext, rootIds: Id[]): Id[] {
  const closure = new Set<Id>(rootIds)
  const queue = [...closure]
  const order: Id[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const ref of findReferencesDetailed(graph, id)) {
      if (!closure.has(ref.id)) {
        closure.add(ref.id)
        queue.push(ref.id)
      }
    }
  }
  return order
}
