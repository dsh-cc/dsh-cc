/**
 * Entity CRUD on the project graph (design
 * docs/plans/2026-10-16-vwa-evidence-argument.md §5 field rules, §10.5
 * argument.update, §15 invalidation table).
 *
 * Mutations run against an in-memory snapshot clone inside the store
 * transaction: ID prefixes (§4), strict schema validation (author contract
 * $defs — additionalProperties:false), UTF-16 span/quote checks (§4/§5.1),
 * SUPPORT_CYCLE, REFERENCE_IN_USE, project-max-entities quota. Validation
 * failures throw {@link VwaFail} so the transaction reports a uniform
 * failure without partial commit.
 *
 * @module @dsh-cc/vwa-argument/graph
 */

import { randomUUID } from 'node:crypto'
import { ajvErrors, authorDefValidator } from './schema.ts'
import { VwaFail, fail, type Fail } from './store.ts'
import { reviseFrozenSettings, type PatchReviewSettings, type ReviewSettingsRevisionOutcome } from './review-settings-revision.ts'
import type { FrozenReviewSettings } from './review-config.ts'
import { computeDeletionClosure, computeDeletionOrder, findReferencesDetailed } from './references.ts'
import type { AnyEntity, EntityKind, ReverseIndex } from './dependencies.ts'
import { applyBindArtifact } from './artifact.ts'
import { buildReverseIndex, findEntity } from './dependencies.ts'
import type {
  Argument, Artifact, Claim, Entity, EvidenceGroup, Id, Issue, Occurrence,
  ProjectContract, ProjectSnapshot,
} from './types.ts'

/** Client-side reference to an object created in the same transaction (§10.5). */
export interface NewRef {
  $new: string
}

export type IdOrNew = Id | NewRef

/** The §10.5 Mutation union (creates limited to claim/group/argument/issue). */
export type Mutation =
  | { op: 'set-contract'; contract: ProjectContract }
  | {
    op: 'upsert'
    creates: { clientKey: string; type: CreateType; body: Record<string, unknown> }[]
    updates: { id: Id; expectedEntityVersion: number; body: Record<string, unknown> }[]
    deletes: Id[]
    /** Feature D §D.4.2: when true, deletes expand to the full reference closure. */
    cascade?: boolean
  }
  | { op: 'bind-artifact'; artifactId?: Id; path: string; occurrences: Occurrence[]; outline: Artifact['outline'] }
  // F3.3: partial capacity revision of the frozen review settings (never maxContextChars).
  // F3.3: partial capacity revision of the frozen review settings (never maxContextChars).
  | { op: 'set-review-settings'; reviewSettings: PatchReviewSettings }

export type { PatchReviewSettings } from './review-settings-revision.ts'

export type CreateType = 'claim' | 'group' | 'argument' | 'issue'

const PREFIX: Record<CreateType, string> = { claim: 'cl', group: 'grp', argument: 'arg', issue: 'iss' }
const KIND_DEF: Record<CreateType, string> = { claim: 'Claim', group: 'EvidenceGroup', argument: 'Argument', issue: 'Issue' }

/** Narrative fields that must be non-empty after trim (§4). */
const NON_EMPTY: Record<CreateType, string[]> = {
  claim: ['text'], group: ['rationale'], argument: ['warrant'], issue: ['description'],
}

/** Per-transaction mutable graph context over the working snapshot clone. */
export class GraphContext {
  /** Decoded source snapshot text by source id — for quote/span validation (§5.1). */
  readonly snapshotTexts: Map<Id, string>
  /** Artifact bytes by path — for bind-artifact exactText validation (§12). */
  readonly artifactTexts: Map<string, string>

  constructor(
    readonly snapshot: ProjectSnapshot,
    readonly maxEntities: number,
    snapshotTexts?: Map<Id, string>,
    /** Fallback artifact reader (the caller's workspace bytes) when the map has no entry. */
    private readonly artifactReader?: (path: string) => string | undefined,
  ) {
    this.snapshotTexts = snapshotTexts ?? new Map()
    this.artifactTexts = new Map()
  }

  now(): string {
    return new Date().toISOString()
  }

  countEntities(): number {
    const snapshot = this.snapshot
    return snapshot.sources.length + snapshot.evidence.length + snapshot.claims.length
      + snapshot.groups.length + snapshot.arguments.length + snapshot.issues.length
      + snapshot.searches.length + snapshot.artifacts.length
  }

  arraysOf(kind: EntityKind): AnyEntity[] {
    return this.snapshot[kind] as unknown as AnyEntity[]
  }

  index(): ReverseIndex {
    return buildReverseIndex(this.snapshot)
  }

  artifactText(path: string): string {
    const text = this.artifactTexts.get(path) ?? this.artifactReader?.(path)
    if (text === undefined) throw new VwaFail(fail('NOT_FOUND', `artifact text for ${path} was not provided to the transaction`))
    return text
  }
}

/** Throw a uniform failure out of an apply function (no partial commit). */
function reject(code: Fail['code'], message: string, details?: import('./schema.ts').JsonValue): never {
  throw new VwaFail(fail(code, message, false, details))
}

/** Create an id with the §4 prefix; users cannot specify ids (§4). */
export function newEntityId(kind: CreateType): Id {
  return `${PREFIX[kind]}_${randomUUID()}`
}

/** Validate one object against its author-schema $def (strict; additionalProperties:false). */
function validateDef(def: string, body: unknown): void {
  const validate = authorDefValidator(def)
  if (!validate(body)) {
    throw new VwaFail(fail('SCHEMA_INVALID', `${def} schema violation: ${ajvErrors(validate)}`))
  }
}

/** Narrative field rule (§4): non-empty after trim. */
function requireNonEmpty(body: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    const value = body[field]
    if (typeof value !== 'string' || value.trim() === '') {
      reject('SCHEMA_INVALID', `${field} must be a non-empty string (after trim)`)
    }
  }
}

export { validateEvidenceAgainstSnapshot } from './evidence-span.ts'

/** Result of one committed mutation set. */
export interface MutationOutcome {
  changedIds: Id[]
  affectedClaimIds: Id[]
  contractChanged: boolean
  /** Feature D §D.4.2: cascade-deleted entities in deletion order (leaves first). */
  cascadeDeleted?: Id[]
  // F3.3 set-review-settings only: revised keys with old/new, the reuse disclosure, and the merged settings (F3.4).
  fieldsChanged?: Record<string, { old: unknown; new: unknown }>
  reuseStatement?: string
  reviewSettings?: FrozenReviewSettings
}

/** Valid mutation ops (§D.1 + F3.3); anything else is rejected before dispatch. */
const VALID_OPS = new Set(['set-contract', 'upsert', 'bind-artifact', 'set-review-settings'])

/** Apply one mutation to the working snapshot in place; full validation on completion (§10.5). */
export function applyMutation(graph: GraphContext, mutation: Mutation): MutationOutcome {
  const changedIds: Id[] = []
  let contractChanged = false
  let cascadeDeleted: Id[] | undefined
  let revision: ReviewSettingsRevisionOutcome & { reviewSettings: FrozenReviewSettings } | undefined
  // Feature D §D.1: validate the op enum at the entrance, before dispatch — an
  // unrecognized op used to fall through to bind-artifact and TypeError.
  if (typeof mutation.op !== 'string' || !VALID_OPS.has(mutation.op)) {
    reject('SCHEMA_INVALID', `missing or unknown op: got ${JSON.stringify((mutation as { op?: unknown }).op)}; expected one of set-contract, upsert, bind-artifact, set-review-settings`)
  }
  if (mutation.op === 'upsert' && (!Array.isArray(mutation.creates) || !Array.isArray(mutation.updates) || !Array.isArray(mutation.deletes))) {
    reject('SCHEMA_INVALID', 'upsert requires creates, updates, and deletes arrays')
  }
  if (mutation.op === 'set-contract') {
    validateDef('ProjectContract', mutation.contract)
    if (mutation.contract.question.trim() === '') reject('SCHEMA_INVALID', 'contract.question must be non-empty')
    // F3.3: with the set-review-settings op available, a set-contract payload
    // carrying reviewSettings is an explicit error (it used to be silently overridden).
    if (mutation.contract.reviewSettings !== undefined) {
      reject('SCHEMA_INVALID', 'set-contract must not carry reviewSettings; use the set-review-settings mutation op (F3.3) to revise the frozen review settings')
    }
    // Absent reviewSettings keeps the frozen ones (F3.3: carrying them is the error above).
    const reviewSettings = graph.snapshot.contract.reviewSettings
    graph.snapshot.contract = { ...mutation.contract, ...(reviewSettings ? { reviewSettings } : {}) }
    contractChanged = true // §15: contract change invalidates all project semantic reviews.
    changedIds.push('contract')
  } else if (mutation.op === 'set-review-settings') {
    // F3.3: partial patch merged in review-settings-revision.ts; contractChanged
    // stays FALSE there (identity excludes reviewSettings, F3.1).
    const revised = reviseFrozenSettings(graph.snapshot.contract, mutation.reviewSettings)
    graph.snapshot.contract = revised.contract
    changedIds.push('contract')
    revision = revised.revision
  } else if (mutation.op === 'upsert') {
    const newIds = new Map<string, Id>()
    for (const create of mutation.creates) {
      const id = createEntity(graph, create.type, create.body, newIds)
      newIds.set(create.clientKey, id)
      changedIds.push(id)
    }
    for (const update of mutation.updates) {
      updateEntity(graph, update, newIds)
      changedIds.push(update.id)
    }
    // Feature D §D.4.2: cascade expands the deletes to the full reference
    // closure BEFORE any deletion; deletion runs in leaves-first dependency
    // order (a Kahn sort, not a reversed BFS). postValidate runs once below,
    // after ALL deletes — intermediate states are never validated.
    if (mutation.cascade === true && mutation.deletes.length > 0) {
      const closure = computeDeletionClosure(graph, mutation.deletes)
      const order = computeDeletionOrder(graph, closure)
      for (const id of order) deleteEntity(graph, id, true)
      changedIds.push(...closure)
      // `order` is already leaves-first; the explicitly requested ids are
      // reported through changedIds, so cascadeDeleted lists only the extras.
      cascadeDeleted = order.filter((id) => !mutation.deletes.includes(id))
    } else {
      for (const deleteId of mutation.deletes) {
        deleteEntity(graph, deleteId)
        changedIds.push(deleteId)
      }
    }
  } else {
    applyBindArtifact(graph, mutation)
    changedIds.push(mutation.artifactId ?? 'artifact')
  }
  postValidate(graph.snapshot)
  return {
    changedIds,
    affectedClaimIds: affectedClaims(graph, changedIds),
    contractChanged,
    ...(cascadeDeleted ? { cascadeDeleted } : {}),
    ...(revision ? { fieldsChanged: revision.fieldsChanged, reuseStatement: revision.reuseStatement, reviewSettings: revision.reviewSettings } : {}),
  }
}

function affectedClaims(graph: GraphContext, changedIds: Id[]): Id[] {
  const affected = new Set<Id>()
  for (const changed of changedIds) {
    if (changed.startsWith('cl_')) affected.add(changed)
    for (const group of graph.snapshot.groups) {
      if (group.id === changed || (changed.startsWith('ev_') && group.evidenceIds.includes(changed))) {
        affected.add(group.targetClaimId)
      }
    }
  }
  return [...affected].sort()
}

function createEntity(
  graph: GraphContext,
  type: CreateType,
  rawBody: Record<string, unknown>,
  newIds: Map<string, Id>,
): Id {
  if (graph.countEntities() >= graph.maxEntities) {
    reject('LIMIT_EXCEEDED', `project entity budget (${graph.maxEntities}) exhausted`)
  }
  const id = newEntityId(type)
  const body = resolveNewRefs(rawBody, newIds)
  const now = graph.now()
  const entity = { id, entityVersion: 1, createdAt: now, updatedAt: now, ...body } as unknown as Entity
  validateEntity(graph, type, entity)
  ;(graph.snapshot[type === 'claim' ? 'claims' : type === 'group' ? 'groups' : type === 'argument' ? 'arguments' : 'issues'] as Entity[]).push(entity)
  return id
}

/** Inline `{$new:clientKey}` resolution; allowed only in ID fields (§10.5). */
function resolveNewRefs(body: Record<string, unknown>, newIds: Map<string, Id>): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>
      if (typeof record.$new === 'string') {
        const resolved = newIds.get(record.$new)
        if (resolved === undefined) reject('REFERENCE_INVALID', `unknown clientKey ${record.$new}`)
        return resolved
      }
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(record)) out[key] = walk(item)
      return out
    }
    return value
  }
  return walk(body) as Record<string, unknown>
}

const CREATE_KIND_TO_SNAPSHOT: Record<CreateType, EntityKind> = {
  claim: 'claims', group: 'groups', argument: 'arguments', issue: 'issues',
}

function locate(graph: GraphContext, id: Id): { kind: EntityKind; entity: AnyEntity } {
  const found = findEntity(graph.index(), id)
  if (found === undefined) reject('REFERENCE_INVALID', `unknown entity ${id}`)
  return found
}

/** System fields are runtime-stamped; a client-supplied system field is a schema error (§5). */
function stripSystemFields(body: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, entityVersion: _version, createdAt: _created, updatedAt: _updated, ...rest } = body
  return rest
}

function validateEntity(_graph: GraphContext, type: CreateType, entity: Entity): void {
  // The full entity (system fields included) validates against the $def;
  // stripSystemFields exists for tool-input normalization only.
  const full = entity as unknown as Record<string, unknown>
  validateDef(KIND_DEF[type], full)
  const plain = stripSystemFields(full)
  requireNonEmpty(plain, NON_EMPTY[type])
  if (type === 'claim') {
    const scope = plain.scope as Claim['scope']
    if (scope !== undefined) {
      if (scope.time === '' || scope.geography === '') {
        reject('SCHEMA_INVALID', 'scope time/geography use the literal "unspecified", never empty strings')
      }
    }
  }
  if (type === 'issue') {
    const issue = entity as unknown as Issue
    if (issue.kind === 'missing-evidence' && issue.gap === undefined) {
      reject('SCHEMA_INVALID', 'missing-evidence issues require gap')
    }
    if (issue.kind !== 'missing-evidence' && issue.gap !== undefined) {
      reject('SCHEMA_INVALID', 'only missing-evidence issues may carry gap')
    }
    if (issue.resolution === 'open' && issue.response.trim() === '') {
      // §5.1: response may be empty when open; non-empty required otherwise.
    } else if (issue.resolution !== 'open' && issue.response.trim() === '') {
      reject('SCHEMA_INVALID', `response must be non-empty when resolution is ${issue.resolution}`)
    }
  }
  if (type === 'argument') {
    const argument = entity as unknown as Argument
    if (argument.premiseClaimIds.length === 0 && argument.evidenceGroupIds.length === 0) {
      reject('SCHEMA_INVALID', `argument ${entity.id} needs at least one premise or evidence group`)
    }
  }
  if (type === 'group') {
    const group = entity as unknown as EvidenceGroup
    if (group.evidenceIds.length === 0 || new Set(group.evidenceIds).size !== group.evidenceIds.length) {
      reject('SCHEMA_INVALID', 'evidenceIds must be non-empty and deduplicated')
    }
  }
  if (type === 'claim' || type === 'group' || type === 'argument' || type === 'issue') {
    // Evidence-group target check and quote validation run in postValidate/creation paths below.
  }
}

function updateEntity(
  graph: GraphContext,
  update: { id: Id; expectedEntityVersion: number; body: Record<string, unknown> },
  newIds: Map<string, Id>,
): void {
  const located = locate(graph, update.id)
  const entity = located.entity as Entity
  if (entity.entityVersion !== update.expectedEntityVersion) {
    reject('ENTITY_VERSION_CONFLICT', `${update.id} is at entityVersion ${entity.entityVersion}`)
  }
  const createType = (Object.keys(CREATE_KIND_TO_SNAPSHOT) as CreateType[]).find((kind) => CREATE_KIND_TO_SNAPSHOT[kind] === located.kind)
  if (createType === undefined) {
    reject('SCHEMA_INVALID', `updates are limited to claim/group/argument/issue; ${update.id} is a ${located.kind}`)
  }
  const body = resolveNewRefs(update.body, newIds)
  const updated = {
    ...body, id: entity.id, entityVersion: entity.entityVersion + 1,
    createdAt: entity.createdAt, updatedAt: graph.now(),
  } as unknown as Entity
  validateEntity(graph, createType as CreateType, updated)
  const array = graph.snapshot[located.kind] as Entity[]
  const position = array.findIndex((candidate) => candidate.id === update.id)
  array[position] = updated
}

function deleteEntity(graph: GraphContext, id: Id, cascade = false): void {
  const located = locate(graph, id)
  if (!cascade) {
    const references = findReferencesDetailed(graph, id)
    if (references.length > 0) {
      // Feature D §D.4.1: name the concrete referencers and carry them in details.
      reject(
        'REFERENCE_IN_USE',
        `${id} is still referenced by: ${references.map((r) => `${r.kind} ${r.id} (${r.role})`).join(', ')}`,
        { references: references as unknown as import('./schema.ts').JsonValue },
      )
    }
  }
  const array = graph.snapshot[located.kind] as Entity[]
  const position = array.findIndex((candidate) => candidate.id === id)
  if (position >= 0) array.splice(position, 1)
}

/** All object kinds referencing `id` (§10.5: deletes do not cascade). */
export function findReferences(graph: GraphContext, id: Id): string[] {
  const snapshot = graph.snapshot
  const hits = new Set<string>()
  const note = (label: string): void => {
    hits.add(label)
  }
  for (const source of snapshot.sources) {
    if (source.lineage.parentSourceIds.includes(id)) note('source lineage')
    if (source.authenticityBasisEvidenceIds.includes(id)) note('source authenticity basis')
  }
  for (const evidence of snapshot.evidence) if (evidence.sourceId === id) note('evidence source')
  for (const group of snapshot.groups) {
    if (group.targetClaimId === id) note('group target')
    if (group.evidenceIds.includes(id)) note('group evidence')
  }
  for (const argument of snapshot.arguments) {
    if (argument.conclusionClaimId === id || argument.premiseClaimIds.includes(id)) note('argument premise/conclusion')
    if (argument.evidenceGroupIds.includes(id)) note('argument group')
  }
  for (const issue of snapshot.issues) {
    if (issue.targetId === id) note('issue target')
    if (issue.evidenceIds.includes(id)) note('issue evidence')
    if (issue.relatedClaimIds.includes(id)) note('issue related claim')
  }
  for (const search of snapshot.searches) {
    if (search.targetIds.includes(id) || search.corpus.includes(id) || search.resultSourceIds.includes(id)) note('search log')
  }
  for (const artifact of snapshot.artifacts) {
    if (artifact.occurrences.some((occ) => occ.claimId === id)) note('artifact occurrence')
    for (const section of artifact.outline) {
      if (section.claimIds.includes(id) || section.argumentIds.includes(id)) note('artifact outline')
    }
  }
  return [...hits]
}

export function postValidate(snapshot: ProjectSnapshot): void {
  validateReferences(snapshot)
  assertNoSupportCycle(snapshot)
}

function validateReferences(snapshot: ProjectSnapshot): void {
  const sourceIds = new Set(snapshot.sources.map((source) => source.id))
  const evidenceIds = new Set(snapshot.evidence.map((evidence) => evidence.id))
  const claimIds = new Set(snapshot.claims.map((claim) => claim.id))
  for (const evidence of snapshot.evidence) {
    if (!sourceIds.has(evidence.sourceId)) {
      reject('REFERENCE_INVALID', `evidence ${evidence.id} references unknown source ${evidence.sourceId}`)
    }
  }
  for (const group of snapshot.groups) {
    if (!claimIds.has(group.targetClaimId)) {
      reject('REFERENCE_INVALID', `group ${group.id} references unknown claim ${group.targetClaimId}`)
    }
    if (group.evidenceIds.length === 0 || new Set(group.evidenceIds).size !== group.evidenceIds.length) {
      reject('SCHEMA_INVALID', `group ${group.id} evidenceIds must be non-empty and deduplicated`)
    }
    for (const evidenceId of group.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        reject('REFERENCE_INVALID', `group ${group.id} references unknown evidence ${evidenceId}`)
      }
    }
  }
  for (const argument of snapshot.arguments) {
    if (!claimIds.has(argument.conclusionClaimId)) {
      reject('REFERENCE_INVALID', `argument ${argument.id} references unknown conclusion ${argument.conclusionClaimId}`)
    }
    for (const premiseId of argument.premiseClaimIds) {
      if (!claimIds.has(premiseId)) {
        reject('REFERENCE_INVALID', `argument ${argument.id} references unknown premise ${premiseId}`)
      }
    }
    for (const groupId of argument.evidenceGroupIds) {
      const group = snapshot.groups.find((candidate) => candidate.id === groupId)
      if (group === undefined) {
        reject('REFERENCE_INVALID', `argument ${argument.id} references unknown group ${groupId}`)
      }
      if (group.targetClaimId !== argument.conclusionClaimId) {
        reject('SCHEMA_INVALID', `group ${groupId} must target the argument's conclusion claim`)
      }
    }
  }
  for (const issue of snapshot.issues) {
    const known = sourceIds.has(issue.targetId) || evidenceIds.has(issue.targetId)
      || claimIds.has(issue.targetId) || snapshot.arguments.some((argument) => argument.id === issue.targetId)
    if (!known) {
      reject('REFERENCE_INVALID', `issue ${issue.id} references unknown target ${issue.targetId}`)
    }
  }
}

/** DFS cycle detection over conclusion → premise edges (§10.8 SUPPORT_CYCLE). */
export function assertNoSupportCycle(snapshot: ProjectSnapshot): void {
  const edges = new Map<Id, Id[]>()
  for (const argument of snapshot.arguments) {
    for (const premiseId of argument.premiseClaimIds) {
      edges.set(argument.conclusionClaimId, [...(edges.get(argument.conclusionClaimId) ?? []), premiseId])
    }
  }
  const visiting = new Set<Id>()
  const done = new Set<Id>()
  const visit = (claimId: Id): void => {
    if (done.has(claimId)) return
    if (visiting.has(claimId)) reject('SUPPORT_CYCLE', `support cycle through claim ${claimId}`)
    visiting.add(claimId)
    for (const premise of edges.get(claimId) ?? []) visit(premise)
    visiting.delete(claimId)
    done.add(claimId)
  }
  for (const claimId of edges.keys()) visit(claimId)
}
