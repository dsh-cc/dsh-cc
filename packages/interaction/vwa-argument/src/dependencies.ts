/**
 * Dependency digests, reverse index, and invalidation propagation (design
 * docs/plans/2026-10-16-vwa-evidence-argument.md §11.4, §15).
 *
 * - `entityContentHash` — SHA-256 over the entity's stableJson.
 * - `dependencyDigest` — stableJson hash over ID-sorted targets and their
 *   recursive dependencies `{id, entityVersion, contentHash}` (§11.4).
 *   Upstream review recordHashes are a parameter (empty until the review
 *   slice lands — the stub boundary of §11.4); they enter the digest when
 *   non-empty.
 * - `buildReverseIndex` + `invalidationTargets` — the §15 propagation table.
 *
 * @module @dsh-cc/vwa-argument/dependencies
 */

import { sha256Hex, stableJson } from './schema.ts'
import type { Artifact, Argument, Claim, Evidence, EvidenceGroup, Issue, ProjectSnapshot, SearchLog, Source } from './types.ts'

/** All author entity kinds keyed by their ProjectSnapshot array field. */
export type EntityKind = 'sources' | 'evidence' | 'claims' | 'groups' | 'arguments' | 'issues' | 'searches' | 'artifacts'

/** One entity in the index; entities are discriminated by the snapshot array they came from. */
export type AnyEntity = Source | Evidence | Claim | EvidenceGroup | Argument | Issue | SearchLog | Artifact

/** Per-kind index of id → entity. */
export type ReverseIndex = {
  sources: Map<string, Source>
  evidence: Map<string, Evidence>
  claims: Map<string, Claim>
  groups: Map<string, EvidenceGroup>
  arguments: Map<string, Argument>
  issues: Map<string, Issue>
  searches: Map<string, SearchLog>
  artifacts: Map<string, Artifact>
}

/** Build the reverse index for one snapshot (§15). */
export function buildReverseIndex(snapshot: ProjectSnapshot): ReverseIndex {
  return {
    sources: new Map(snapshot.sources.map((e) => [e.id, e])),
    evidence: new Map(snapshot.evidence.map((e) => [e.id, e])),
    claims: new Map(snapshot.claims.map((e) => [e.id, e])),
    groups: new Map(snapshot.groups.map((e) => [e.id, e])),
    arguments: new Map(snapshot.arguments.map((e) => [e.id, e])),
    issues: new Map(snapshot.issues.map((e) => [e.id, e])),
    searches: new Map(snapshot.searches.map((e) => [e.id, e])),
    artifacts: new Map(snapshot.artifacts.map((e) => [e.id, e])),
  }
}

/** Stable content hash of one entity (§11.4 `{id,entityVersion,contentHash}`). */
export function entityContentHash(entity: AnyEntity): string {
  return sha256Hex(stableJson(entity))
}

/** Locate an entity (any kind) by id; undefined when absent. */
export function findEntity(index: ReverseIndex, id: string): { kind: EntityKind; entity: AnyEntity } | undefined {
  for (const kind of ['sources', 'evidence', 'claims', 'groups', 'arguments', 'issues', 'searches', 'artifacts'] as const) {
    const entity = index[kind].get(id)
    if (entity !== undefined) return { kind, entity }
  }
  return undefined
}

/**
 * Recursive dependency closure entry (§11.4): the target plus everything it
 * rests on — claim→(groups→evidence→source, arguments→premises) — each as
 * `{id, entityVersion, contentHash}`, sorted by id.
 */
export function dependencyEntries(index: ReverseIndex, targetIds: string[]): { id: string; entityVersion: number; contentHash: string }[] {
  const seen = new Set<string>()
  const entries: { id: string; entityVersion: number; contentHash: string }[] = []
  const visit = (kind: EntityKind, id: string): void => {
    const key = `${kind}:${id}`
    if (seen.has(key)) return
    seen.add(key)
    const entity = index[kind].get(id)
    if (entity === undefined) return
    entries.push({ id, entityVersion: entity.entityVersion, contentHash: entityContentHash(entity) })
    switch (kind) {
      case 'arguments': {
        const argument = entity as Argument
        for (const premiseId of argument.premiseClaimIds) visit('claims', premiseId)
        for (const groupId of argument.evidenceGroupIds) visit('groups', groupId)
        break
      }
      case 'claims': {
        const claim = entity as Claim
        for (const argumentId of index.arguments.values()) {
          if (argumentId.premiseClaimIds.includes(id) || argumentId.conclusionClaimId === id) {
            visit('arguments', argumentId.id)
          }
        }
        for (const group of index.groups.values()) {
          if (group.targetClaimId === id) for (const evId of group.evidenceIds) visit('evidence', evId)
        }
        for (const sourceId of claim.scope.corpus) visit('sources', sourceId)
        break
      }
      case 'groups': {
        for (const evId of (entity as EvidenceGroup).evidenceIds) visit('evidence', evId)
        break
      }
      case 'evidence': {
        visit('sources', (entity as Evidence).sourceId)
        break
      }
      default:
        break
    }
  }
  for (const id of targetIds) visit('claims', id)
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return entries
}

/** §11.4 digest: stableJson hash over the sorted dependency entries + upstream record hashes. */
export function dependencyDigest(index: ReverseIndex, targetIds: string[], upstreamRecordHashes: string[] = []): string {
  return sha256Hex(stableJson({
    dependencies: dependencyEntries(index, targetIds),
    upstreamRecordHashes: [...upstreamRecordHashes].sort(),
  }))
}

/**
 * §15 invalidation table: the review targets a change to one entity must
 * invalidate (its own closure plus all downstream).
 */
export function invalidationScope(index: ReverseIndex, kind: EntityKind, id: string): string[] {
  const affected = new Set<string>([id])
  const addClaimClosure = (claimId: string): void => {
    affected.add(claimId)
    for (const argument of index.arguments.values()) {
      if (argument.premiseClaimIds.includes(claimId)) addClaimClosure(argument.conclusionClaimId)
    }
  }
  const claimOfEvidence = (evidenceId: string): void => {
    for (const group of index.groups.values()) {
      if (group.evidenceIds.includes(evidenceId)) addClaimClosure(group.targetClaimId)
    }
  }
  switch (kind) {
    case 'sources': {
      for (const evidence of index.evidence.values()) {
        if (evidence.sourceId === id) claimOfEvidence(evidence.id)
      }
      break
    }
    case 'evidence':
      claimOfEvidence(id)
      break
    case 'claims':
      addClaimClosure(id)
      break
    case 'groups': {
      const group = index.groups.get(id)
      if (group !== undefined) addClaimClosure(group.targetClaimId)
      break
    }
    case 'arguments': {
      const argument = index.arguments.get(id)
      if (argument !== undefined) addClaimClosure(argument.conclusionClaimId)
      break
    }
    case 'issues': {
      const issue = index.issues.get(id)
      if (issue !== undefined) addClaimClosure(issue.targetId)
      break
    }
    case 'searches': {
      const search = index.searches.get(id)
      if (search !== undefined) for (const targetId of search.targetIds) addClaimClosure(targetId)
      break
    }
    case 'artifacts':
      // Artifact bytes/occurrences/outline invalidate that artifact's audit family.
      break
  }
  return [...affected].sort()
}
