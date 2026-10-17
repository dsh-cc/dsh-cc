/**
 * Audit stage (design docs/plans/2026-10-16-vwa-evidence-argument.md §12,
 * §11.4): independent full-text reverse extraction and alignment.
 *
 * - Extraction units are the root-level children of a CommonMark parse
 *   ({@link rootBlocks} in review-plan.ts). An over-long block is split at
 *   sentence boundaries; if none is found, hard-split, keeping 512 chars of
 *   context before and after. Context is never part of the extraction
 *   target; returned spans MUST fall inside the target block, except a
 *   boundary-crossing sentence at the unit's end may extend into the
 *   following context (§12).
 * - Lane-2 strips `〔claim:<id>〕` markers BEFORE extraction and keeps an
 *   offset map so spans stay valid against the ORIGINAL text (§19/D24).
 * - The extract response is stored independently as an `ExtractionRecord`
 *   (stage 'extract', response `{items}`); align returns the §11.4
 *   `AlignResponse` (findings + alignment, each extracted item exactly once).
 *   Only exact/equivalent count as aligned; stronger/broader/new generate
 *   findings (AUDIT_NEW_CLAIM → AUDIT-01, AUDIT_STRONGER/AUDIT_BROADER →
 *   AUDIT-02, all fixed major per §11.4) and never overwrite author claims.
 * - Core discovery (§12.1): if execution discovers a new core claim, the run
 *   is marked needs-review and a NEW run is required — never an online
 *   reclassification.
 *
 * @module @dsh-cc/vwa-argument/audit
 */

import { randomUUID } from 'node:crypto'
import { sha256Hex, stableJson } from './schema.ts'
import { loadPrompt, responseSchemaFor, promptHash, RULES } from './review-contract.ts'
import { auditDependencyDigest } from './review-current.ts'
import { buildReverseIndex } from './dependencies.ts'
import { computeCoreSet } from './review-plan.ts'
import type { ReviewCaller } from './review-call.ts'
import {
  AuditInvalidError,
  extractionUnits,
  stripClaimMarkers,
  EXTRACT_RESPONSE_SCHEMA,
  parseExtractResponse,
  validateExtractItems,
  type ExtractEnvelope,
  type AlignEnvelope,
} from './audit-input.ts'
export {
  AuditInvalidError,
  extractionUnits,
  stripClaimMarkers,
  EXTRACT_RESPONSE_SCHEMA,
  validateExtractItems,
} from './audit-input.ts'
export type { ExtractionUnit, ExtractEnvelope, AlignEnvelope } from './audit-input.ts'
import {
  validateTaskResponse,
  parseReviewResponse,
  type ReviewModelAdapter,
  type ReviewMessages,
} from './review-adapter.ts'
import type {
  ExtractedAtomicClaim,
  ExtractionRecord,
  Finding,
  Hash,
  Id,
  ProjectSnapshot,
  ReviewRecord,
  Span,
} from './types.ts'

export interface AuditOutcome {
  extractionRecord: ExtractionRecord
  alignRecord: ReviewRecord
  findings: Finding[]
  extractedAtomicClaims: ExtractedAtomicClaim[]
  /** Atomic claims mapping to NO author claim (proposals only, §12). */
  newClaimProposals: { text: string; kind: string; importance: string; span: Span }[]
  /** §12.1: a new CORE claim was discovered → needs-review; a new run is required. */
  needsReview: boolean
  metrics: { extractedAtomicClaims: number; mappedAtomicClaims: number }
}

/** Runtime item id: derived from taskId + span (§11.4). */
function itemExtractedId(taskId: string, span: Span): Id {
  return `ext_${sha256Hex(stableJson({ taskId, start: span.start, end: span.end })).slice(0, 32)}`
}

/** Runtime atomic extraction id: taskId + span + atomic sequence number (§11.4). */
function atomicExtractionId(taskId: string, span: Span, seq: number): Id {
  return `ext_${sha256Hex(stableJson({ taskId, start: span.start, end: span.end, seq })).slice(0, 32)}`
}

/**
 * Run one full audit (extract + align) for one bound artifact. The artifact
 * text is passed in already read (the caller owns path/hash currency).
 */
export async function executeAudit(input: {
  adapter: ReviewModelAdapter
  runId: Id
  artifact: { id: Id; path: string; text: string }
  snapshot: ProjectSnapshot
  rubricVersion: string
  contractHash: Hash
  policyHash: Hash
  reviewerConfigHash: Hash
  maxOutputTokens: number
  maxUnitChars: number
  signal: AbortSignal
  caller?: ReviewCaller
  records?: ReviewRecord[]
  coreClaimIds?: Id[]
}): Promise<AuditOutcome> {
  const { artifact, snapshot, runId } = input
  const stripped = stripClaimMarkers(artifact.text)
  const units = extractionUnits(
    stripped.text,
    Math.min(
      input.maxUnitChars,
      input.caller ? Math.max(1, Math.floor(input.caller.maxContextChars / 2)) : input.maxUnitChars,
    ),
  )
  const taskId = `task_${randomUUID()}`
  const artifactHash = sha256Hex(artifact.text)
  const inputHash = sha256Hex(stableJson({ artifactHash, units: units.length, contract: snapshot.contract }))

  const dispatch = async (
    prompt: string,
    envelope: unknown,
    schema: object,
    parse: (raw: string) => unknown,
  ): Promise<{ raw: unknown; inputTokens: number; outputTokens: number }> => {
    const messages: ReviewMessages = [
      { role: 'system', content: prompt },
      { role: 'user', content: stableJson(envelope) },
    ]
    if (input.caller) return input.caller.call(taskId, messages, schema, parse)
    const call = await input.adapter.prepareReviewCall({
      messages,
      responseSchema: schema,
      maxOutputTokens: input.maxOutputTokens,
      signal: input.signal,
    })
    const result = await call.dispatch()
    return { raw: parse(result.raw), inputTokens: result.inputTokens ?? 0, outputTokens: result.outputTokens ?? 0 }
  }

  // ---- occurrence validation FIRST (§11.1: broken input never spends model budget) ----
  const boundArtifact = snapshot.artifacts.find((art) => art.id === artifact.id)
  const occurrences = boundArtifact?.occurrences ?? []
  for (const occurrence of occurrences) {
    if (artifact.text.slice(occurrence.span.start, occurrence.span.end) !== occurrence.exactText) {
      throw new AuditInvalidError(
        `occurrence exactText does not match the artifact slice for claim ${occurrence.claimId}`,
      )
    }
  }

  // ---- extract stage (§12) ----
  const startedAt = new Date().toISOString()
  const extractPrompt = loadPrompt('extract')
  const extractEnvelope: ExtractEnvelope = {
    stage: 'extract',
    runId,
    taskId,
    rubricVersion: input.rubricVersion,
    contract: snapshot.contract,
    units: units.map((u) => ({
      unitId: u.unitId,
      span: u.span,
      text: u.text,
      context: u.context,
      ...(u.heading === undefined ? {} : { heading: u.heading }),
    })),
    budget: { maxOutputTokens: input.maxOutputTokens },
  }
  const batches: (typeof units)[] = []
  let batch: typeof units = [],
    chars = 0
  for (const unit of units) {
    if (batch.length && chars + stableJson(unit).length > (input.caller?.maxContextChars ?? Infinity) * 0.7) {
      batches.push(batch)
      batch = []
      chars = 0
    }
    batch.push(unit)
    chars += stableJson(unit).length
  }
  if (batch.length || batches.length === 0) batches.push(batch)
  const collected: import('./types.ts').ExtractedItem[] = []
  let extractInputTokens = 0,
    extractOutputTokens = 0
  for (const batch of batches) {
    const envelope = {
      ...extractEnvelope,
      units: batch.map((u) => ({
        ...u,
        before: stripped.text.slice(u.context.start, u.span.start),
        after: stripped.text.slice(u.span.end, u.context.end),
      })),
    }
    const raw = await dispatch(extractPrompt, envelope, EXTRACT_RESPONSE_SCHEMA, parseExtractResponse)
    collected.push(...validateExtractItems((raw.raw as { items?: unknown }).items, stripped.text, batch))
    extractInputTokens += raw.inputTokens
    extractOutputTokens += raw.outputTokens
  }
  const extractItems = validateExtractItems(collected, stripped.text, units)

  const extractionRecord: ExtractionRecord = {
    runId,
    stage: 'extract',
    targetRefs: [{ id: artifact.id, entityVersion: boundArtifact?.entityVersion ?? 1 }],
    dependencyDigest: auditDependencyDigest(snapshot, artifact.id, input.records ?? []),
    artifactHash,
    contractHash: input.contractHash,
    policyHash: input.policyHash,
    reviewerConfigHash: input.reviewerConfigHash,
    promptHash: promptHash('extract'),
    inputHash,
    status: 'completed',
    inputTokens: extractInputTokens,
    outputTokens: extractOutputTokens,
    startedAt,
    endedAt: new Date().toISOString(),
    response: { items: extractItems },
  }

  // ---- runtime derivation: item ids + original-coordinate spans (§19 offset map) ----
  const derivations = extractItems.map((item) => ({
    item,
    extractedId: itemExtractedId(taskId, item.span),
    originalSpan: {
      start: stripped.strippedToOriginal(item.span.start),
      end: stripped.strippedToOriginal(item.span.end),
    } as Span,
  }))

  // ---- align stage (§12) ----
  const alignStart = new Date().toISOString()
  const alignPrompt = loadPrompt('align')
  const alignEnvelope: AlignEnvelope & Record<string, unknown> = {
    stage: 'align',
    runId,
    taskId,
    rubricVersion: input.rubricVersion,
    contract: snapshot.contract,
    items: derivations.map((d) => ({
      extractedId: d.extractedId,
      span: d.item.span,
      quote: d.item.exactText,
      atomicClaims: d.item.atomicClaims.map((c) => ({
        text: c.text,
        kind: c.kind,
        importance: c.importance,
        scope: c.scope,
      })),
      isQuotation: d.item.isQuotation,
    })),
    claims: snapshot.claims.map((claim) => ({
      id: claim.id,
      text: claim.text,
      kind: claim.kind,
      importance: claim.importance,
      stance: claim.stance,
      scope: claim.scope,
    })),
    occurrences,
    artifact: artifact.text,
    outline: boundArtifact?.outline ?? [],
    requiredRules: ['AUDIT-01', 'AUDIT-02', 'AUDIT-03', 'AUDIT-04', 'AUDIT-05'].map((ruleId) => ({
      targetId: artifact.id,
      ruleId,
    })),
    ruleDefinitions: Object.fromEntries(Object.entries(RULES).filter(([id]) => id.startsWith('AUDIT-'))),
    currentReviewRecords: input.records ?? [],
    issues: snapshot.issues,
    groups: snapshot.groups,
    arguments: snapshot.arguments,
    searches: snapshot.searches,
    effectiveCoreClaimIds: input.coreClaimIds ?? [
      ...computeCoreSet({
        index: buildReverseIndex(snapshot),
        artifactText: artifact.text,
        requiredQuestionTexts: snapshot.contract.requiredQuestions.map((q) => q.text),
      }),
    ],
    budget: { maxOutputTokens: input.maxOutputTokens },
  }
  const alignPromptHash = promptHash('align')
  const alignRaw = await dispatch(alignPrompt, alignEnvelope, responseSchemaFor('align'), parseReviewResponse)
  const alignResponse = alignRaw.raw as import('./types.ts').AlignResponse
  validateAlignment(
    alignResponse,
    derivations,
    snapshot.claims.map((claim) => claim.id),
  )
  if (input.caller)
    validateTaskResponse(alignResponse, {
      stage: 'align',
      targetIds: new Set([artifact.id, ...snapshot.claims.map((c) => c.id)]),
      requiredRules: new Map([[artifact.id, new Set(['AUDIT-01', 'AUDIT-02', 'AUDIT-03', 'AUDIT-04', 'AUDIT-05'])]]),
      knownEvidenceIds: new Set(snapshot.evidence.map((e) => e.id)),
    })
  alignResponse.alignment = derivations.map(
    (d) => alignResponse.alignment.find((a) => a.extractedId === d.extractedId)!,
  )

  // ---- runtime findings (§11.4): the three AUDIT codes are fixed major ----
  const findings: Finding[] = [...alignResponse.findings]
  const alignedItemIds = new Set(
    alignResponse.alignment
      .filter((entry) => entry.relation === 'exact' || entry.relation === 'equivalent')
      .map((entry) => entry.extractedId),
  )
  const newClaimProposals: AuditOutcome['newClaimProposals'] = []
  let newCoreDiscovered = false
  for (const entry of alignResponse.alignment) {
    if (entry.relation !== 'new') continue
    const derivation = derivations.find((d) => d.extractedId === entry.extractedId)!
    for (const atomic of derivation.item.atomicClaims) {
      newClaimProposals.push({
        text: atomic.text,
        kind: atomic.kind,
        importance: atomic.importance,
        span: derivation.originalSpan,
      })
      if (atomic.importance === 'core') newCoreDiscovered = true // §12.1 core discovery
      findings.push({
        id: `finding_${randomUUID()}`,
        code: 'AUDIT_NEW_CLAIM',
        targetIds: [artifact.id],
        severity: 'major', // fixed major (§11.4); maps to AUDIT-01
        explanation: `Extracted claim maps to no author claim: ${atomic.text}`,
        evidenceIds: [],
        artifactSpans: [derivation.originalSpan],
        repair: 'add-evidence',
      })
    }
  }
  for (const entry of alignResponse.alignment) {
    if (entry.relation !== 'stronger' && entry.relation !== 'broader') continue
    const derivation = derivations.find((d) => d.extractedId === entry.extractedId)!
    findings.push({
      id: `finding_${randomUUID()}`,
      code: entry.relation === 'stronger' ? 'AUDIT_STRONGER' : 'AUDIT_BROADER',
      targetIds: [...entry.claimIds],
      severity: 'major', // fixed major (§11.4); maps to AUDIT-02
      explanation: `Extracted claim is ${entry.relation} than the mapped author claim: ${entry.rationale}`,
      evidenceIds: [],
      artifactSpans: [derivation.originalSpan],
      repair: entry.relation === 'stronger' ? 'qualify' : 'narrow-claim',
    })
  }

  const core = new Set(input.coreClaimIds ?? [])
  for (const d of derivations) {
    if (!d.item.atomicClaims.some((c) => c.importance === 'core')) continue
    const mapped = alignResponse.alignment.find((a) => a.extractedId === d.extractedId)?.claimIds ?? []
    if (input.coreClaimIds && mapped.some((id) => !core.has(id))) newCoreDiscovered = true
  }
  const discoveredCore = [
    ...new Set([
      ...core,
      ...derivations
        .filter((d) => d.item.atomicClaims.some((c) => c.importance === 'core'))
        .flatMap((d) => alignResponse.alignment.find((a) => a.extractedId === d.extractedId)?.claimIds ?? []),
    ]),
  ]
  const alignRecord: ReviewRecord = {
    coreClaimIds: discoveredCore,
    runId,
    stage: 'align',
    targetRefs: [{ id: artifact.id, entityVersion: boundArtifact?.entityVersion ?? 1 }],
    dependencyDigest: auditDependencyDigest(snapshot, artifact.id, input.records ?? []),
    artifactHash,
    contractHash: input.contractHash,
    policyHash: input.policyHash,
    reviewerConfigHash: input.reviewerConfigHash,
    promptHash: alignPromptHash,
    inputHash,
    status: 'completed',
    inputTokens: alignRaw.inputTokens,
    outputTokens: alignRaw.outputTokens,
    startedAt: alignStart,
    endedAt: new Date().toISOString(),
    response: { ...alignResponse, findings },
  }

  const extractedAtomicClaims: ExtractedAtomicClaim[] = derivations.flatMap((d) => {
    const claimIds = alignResponse.alignment.find((entry) => entry.extractedId === d.extractedId)?.claimIds ?? []
    const claimId = (d.item.isQuotation ? claimIds[0] : claimIds[0]) ?? '' // proposals carry an empty claimId until adopted
    return d.item.atomicClaims.map((atomic, seq) => ({
      extractionId: atomicExtractionId(taskId, d.item.span, seq),
      claimId,
      span: d.originalSpan,
      quote: artifact.text.slice(d.originalSpan.start, d.originalSpan.end),
      kind: atomic.kind,
    }))
  })

  const extractedCount = derivations.reduce((sum, d) => sum + d.item.atomicClaims.length, 0)
  const mappedCount = derivations
    .filter((d) => alignedItemIds.has(d.extractedId))
    .reduce((sum, d) => sum + d.item.atomicClaims.length, 0)

  return {
    extractionRecord,
    alignRecord,
    findings,
    extractedAtomicClaims,
    newClaimProposals,
    needsReview: newCoreDiscovered,
    metrics: { extractedAtomicClaims: extractedCount, mappedAtomicClaims: mappedCount },
  }
}

/**
 * Validate the extract response (§12): every span must exactly match the
 * stripped artifact and fall inside its target unit, EXCEPT a
 * boundary-crossing sentence at the unit's end may extend into the following
 * context. Deduplicates by span/text.
 */
/**
 * Validate the align response (§11.4): each extracted item appears exactly
 * once; relation 'new' → claimIds EMPTY; every other relation → claimIds
 * non-empty and valid.
 */
export function validateAlignment(
  response: import('./types.ts').AlignResponse,
  derivations: { extractedId: Id }[],
  claimIds: readonly Id[],
): void {
  const expected = new Set(derivations.map((d) => d.extractedId))
  const known = new Set(claimIds)
  const seen = new Set<Id>()
  for (const entry of response.alignment) {
    if (!expected.has(entry.extractedId))
      throw new AuditInvalidError(`alignment references unknown extractedId ${entry.extractedId}`)
    if (seen.has(entry.extractedId)) throw new AuditInvalidError(`extracted item aligned twice: ${entry.extractedId}`)
    seen.add(entry.extractedId)
    if (entry.relation === 'new') {
      if (entry.claimIds.length > 0) throw new AuditInvalidError('relation new must have empty claimIds')
      continue
    }
    if (entry.claimIds.length === 0)
      throw new AuditInvalidError(`relation ${entry.relation} requires non-empty claimIds`)
    for (const id of entry.claimIds) {
      if (!known.has(id)) throw new AuditInvalidError(`alignment references unknown claim ${id}`)
    }
  }
  for (const id of expected) {
    if (!seen.has(id)) throw new AuditInvalidError(`extracted item missing from alignment: ${id}`)
  }
}
