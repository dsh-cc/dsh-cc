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
import { rootBlocks } from './review-plan.ts'
import { loadPrompt, responseSchemaFor } from './review-runner.ts'
import { parseReviewResponse, type ReviewModelAdapter, type ReviewMessages } from './review-adapter.ts'
import type {
  ExtractedAtomicClaim, ExtractedItem, ExtractionRecord, Finding, Hash, Id,
  ProjectSnapshot, ReviewRecord, Span,
} from './types.ts'

/** One extraction unit: a root block, or an over-long block split into pieces. */
export interface ExtractionUnit {
  unitId: string
  /** Span of the extraction TARGET in stripped-artifact coordinates. */
  span: Span
  text: string
  /** Context window (up to 512 chars each side for splits; otherwise = span). */
  context: Span
  heading?: { level: number; text: string }
}

const CONTEXT_CHARS = 512

/** Sentence-split pieces of one over-long block (hard split when no boundary). */
function splitOverLong(start: number, end: number, body: string, maxUnitChars: number): { start: number; end: number }[] {
  const pieces: { start: number; end: number }[] = []
  const sentenceEnds: number[] = []
  const re = /[.!?。！？](?!\d)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(body)) !== null) sentenceEnds.push(match.index + match[0].length)
  let from = 0
  if (sentenceEnds.length === 0) {
    // Hard split: no sentence boundary exists at all (§12).
    for (; from < body.length; from += maxUnitChars) {
      pieces.push({ start: start + from, end: Math.min(end, start + from + maxUnitChars) })
    }
    return pieces
  }
  for (const cut of sentenceEnds) {
    if (cut - from >= maxUnitChars) {
      pieces.push({ start: start + from, end: start + cut })
      from = cut
    }
  }
  if (from < body.length) pieces.push({ start: start + from, end })
  return pieces
}

/**
 * Split the artifact into extraction units (§12): one per root block; an
 * over-long block (> maxUnitChars) is sentence-split, each piece keeping up
 * to 512 chars of context before and after. The artifact is the
 * CLAIM-MARKER-STRIPPED text.
 */
export function extractionUnits(strippedText: string, maxUnitChars: number): ExtractionUnit[] {
  const units: ExtractionUnit[] = []
  for (const block of rootBlocks(strippedText)) {
    const pieces = block.body.length <= maxUnitChars
      ? [{ start: block.start, end: block.end }]
      : splitOverLong(block.start, block.end, block.body, maxUnitChars)
    for (const piece of pieces) {
      units.push({
        unitId: `unit_${units.length}`,
        span: piece,
        text: strippedText.slice(piece.start, piece.end),
        context: {
          start: Math.max(0, piece.start - CONTEXT_CHARS),
          end: Math.min(strippedText.length, piece.end + CONTEXT_CHARS),
        },
        ...(block.heading === undefined ? {} : { heading: block.heading }),
      })
    }
  }
  return units
}

/**
 * Strip `〔claim:<id>〕` authoring-aid markers and keep the offset map back
 * to the ORIGINAL text (§19): extraction spans are returned against the
 * stripped text and mapped back so they remain valid against the original.
 */
export function stripClaimMarkers(text: string): { text: string; strippedToOriginal: (offset: number) => number } {
  const removed: { start: number; end: number }[] = []
  const re = /〔claim:[^\s〕]+〕/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) removed.push({ start: match.index, end: match.index + match[0].length })
  let out = ''
  let cursor = 0
  for (const range of removed) {
    out += text.slice(cursor, range.start)
    cursor = range.end
  }
  out += text.slice(cursor)
  const map = (offset: number): number => {
    // Walk the removals in order: a stripped offset at/after a removal point
    // shifts by that removal's length (and stays shifted by all earlier ones).
    let shift = 0
    for (const range of removed) {
      if (offset < range.start - shift) break
      shift += range.end - range.start
    }
    return offset + shift
  }
  return { text: out, strippedToOriginal: map }
}

/** Envelope for the extract-stage call (§11.4 closure; extract returns {items}, not a ReviewResponse). */
export interface ExtractEnvelope {
  stage: 'extract'
  runId: Id
  taskId: string
  rubricVersion: string
  contract: ProjectSnapshot['contract']
  units: { unitId: string; span: Span; text: string; context: { start: number; end: number }; heading?: { level: number; text: string } }[]
  budget: { maxOutputTokens: number }
}

/** Envelope for the align-stage call (§11.4). */
export interface AlignEnvelope {
  stage: 'align'
  runId: Id
  taskId: string
  rubricVersion: string
  contract: ProjectSnapshot['contract']
  items: { extractedId: Id; span: Span; quote: string; atomicClaims: { text: string; kind: string; importance: string }[]; isQuotation: boolean }[]
  claims: { id: Id; text: string; kind: string; importance: string; stance: string }[]
  occurrences: { claimId: Id; span: Span; exactText: string }[]
  budget: { maxOutputTokens: number }
}

/** Forced-tool schema for the extract stage (§12 response, not a ReviewResponse). */
export const EXTRACT_RESPONSE_SCHEMA: object = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      maxItems: 1000,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['span', 'exactText', 'atomicClaims', 'isQuotation'],
        properties: {
          span: { type: 'object', additionalProperties: false, required: ['start', 'end'], properties: { start: { type: 'integer' }, end: { type: 'integer' } } },
          exactText: { type: 'string', minLength: 1, maxLength: 12000 },
          atomicClaims: {
            type: 'array', minItems: 1, maxItems: 1000,
            items: {
              type: 'object', additionalProperties: false,
              required: ['text', 'kind', 'scope', 'importance'],
              properties: {
                text: { type: 'string', minLength: 1, maxLength: 2000 },
                kind: { enum: ['fact', 'source-report', 'interpretation', 'causal', 'intent', 'evaluation'] },
                scope: { type: 'object' },
                importance: { enum: ['core', 'supporting'] },
              },
            },
          },
          isQuotation: { type: 'boolean' },
        },
      },
    },
  },
}

/** JSON-parse the extract response (it is `{items}`, NOT a ReviewResponse — §11.4). */
function parseExtractResponse(raw: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AuditInvalidError('extract response is not valid JSON')
  }
  return parsed
}

/** Extract/align runtime validation failure — never cached (§11.3/§13). */
export class AuditInvalidError extends Error {
  readonly code = 'REVIEW_INVALID'
  constructor(message: string) {
    super(message)
    this.name = 'AuditInvalidError'
  }
}

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
}): Promise<AuditOutcome> {
  const { artifact, snapshot, runId } = input
  const stripped = stripClaimMarkers(artifact.text)
  const units = extractionUnits(stripped.text, input.maxUnitChars)
  const taskId = `task_${randomUUID()}`
  const artifactHash = sha256Hex(stableJson(artifact.text))
  const inputHash = sha256Hex(stableJson({ artifactHash, units: units.length, contract: snapshot.contract }))

  const dispatch = async (prompt: string, envelope: unknown, schema: object, parse: (raw: string) => unknown): Promise<{ raw: unknown; inputTokens: number; outputTokens: number }> => {
    const messages: ReviewMessages = [
      { role: 'system', content: prompt },
      { role: 'user', content: stableJson(envelope) },
    ]
    const call = await input.adapter.prepareReviewCall({
      messages, responseSchema: schema, maxOutputTokens: input.maxOutputTokens, signal: input.signal,
    })
    const result = await call.dispatch()
    return { raw: parse(result.raw), inputTokens: result.inputTokens ?? 0, outputTokens: result.outputTokens ?? 0 }
  }

  // ---- occurrence validation FIRST (§11.1: broken input never spends model budget) ----
  const occurrences = snapshot.artifacts.flatMap((art) => art.occurrences)
  for (const occurrence of occurrences) {
    if (artifact.text.slice(occurrence.span.start, occurrence.span.end) !== occurrence.exactText) {
      throw new AuditInvalidError(`occurrence exactText does not match the artifact slice for claim ${occurrence.claimId}`)
    }
  }

  // ---- extract stage (§12) ----
  const startedAt = new Date().toISOString()
  const extractPrompt = loadPrompt('extract')
  const extractEnvelope: ExtractEnvelope = {
    stage: 'extract', runId, taskId, rubricVersion: input.rubricVersion, contract: snapshot.contract,
    units: units.map((u) => ({ unitId: u.unitId, span: u.span, text: u.text, context: u.context, ...(u.heading === undefined ? {} : { heading: u.heading }) })),
    budget: { maxOutputTokens: input.maxOutputTokens },
  }
  const extractRaw = await dispatch(extractPrompt, extractEnvelope, EXTRACT_RESPONSE_SCHEMA, parseExtractResponse)
  const extractItems = validateExtractItems((extractRaw.raw as { items?: unknown }).items, stripped.text, units)

  const extractionRecord: ExtractionRecord = {
    runId, stage: 'extract', targetRefs: [{ id: artifact.id, entityVersion: 1 }],
    dependencyDigest: '', contractHash: input.contractHash, policyHash: input.policyHash,
    reviewerConfigHash: input.reviewerConfigHash, promptHash: sha256Hex(extractPrompt), inputHash,
    status: 'completed', inputTokens: extractRaw.inputTokens, outputTokens: extractRaw.outputTokens,
    startedAt, endedAt: new Date().toISOString(), response: { items: extractItems },
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
  const alignEnvelope: AlignEnvelope = {
    stage: 'align', runId, taskId, rubricVersion: input.rubricVersion, contract: snapshot.contract,
    items: derivations.map((d) => ({
      extractedId: d.extractedId, span: d.item.span, quote: d.item.exactText,
      atomicClaims: d.item.atomicClaims.map((c) => ({ text: c.text, kind: c.kind, importance: c.importance })),
      isQuotation: d.item.isQuotation,
    })),
    claims: snapshot.claims.map((claim) => ({ id: claim.id, text: claim.text, kind: claim.kind, importance: claim.importance, stance: claim.stance })),
    occurrences,
    budget: { maxOutputTokens: input.maxOutputTokens },
  }
  const alignPromptHash = sha256Hex(alignPrompt)
  const alignRaw = await dispatch(alignPrompt, alignEnvelope, responseSchemaFor('align'), parseReviewResponse)
  const alignResponse = alignRaw.raw as import('./types.ts').AlignResponse
  validateAlignment(alignResponse, derivations, snapshot.claims.map((claim) => claim.id))

  // ---- runtime findings (§11.4): the three AUDIT codes are fixed major ----
  const findings: Finding[] = [...alignResponse.findings]
  const alignedItemIds = new Set(
    alignResponse.alignment.filter((entry) => entry.relation === 'exact' || entry.relation === 'equivalent').map((entry) => entry.extractedId),
  )
  const newClaimProposals: AuditOutcome['newClaimProposals'] = []
  let newCoreDiscovered = false
  for (const entry of alignResponse.alignment) {
    if (entry.relation !== 'new') continue
    const derivation = derivations.find((d) => d.extractedId === entry.extractedId)!
    for (const atomic of derivation.item.atomicClaims) {
      newClaimProposals.push({ text: atomic.text, kind: atomic.kind, importance: atomic.importance, span: derivation.originalSpan })
      if (atomic.importance === 'core') newCoreDiscovered = true // §12.1 core discovery
      findings.push({
        id: `finding_${randomUUID()}`, code: 'AUDIT_NEW_CLAIM', targetIds: [artifact.id],
        severity: 'major', // fixed major (§11.4); maps to AUDIT-01
        explanation: `Extracted claim maps to no author claim: ${atomic.text}`,
        evidenceIds: [], artifactSpans: [derivation.originalSpan], repair: 'add-evidence',
      })
    }
  }
  for (const entry of alignResponse.alignment) {
    if (entry.relation !== 'stronger' && entry.relation !== 'broader') continue
    const derivation = derivations.find((d) => d.extractedId === entry.extractedId)!
    findings.push({
      id: `finding_${randomUUID()}`,
      code: entry.relation === 'stronger' ? 'AUDIT_STRONGER' : 'AUDIT_BROADER',
      targetIds: [...entry.claimIds], severity: 'major', // fixed major (§11.4); maps to AUDIT-02
      explanation: `Extracted claim is ${entry.relation} than the mapped author claim: ${entry.rationale}`,
      evidenceIds: [], artifactSpans: [derivation.originalSpan],
      repair: entry.relation === 'stronger' ? 'qualify' : 'narrow-claim',
    })
  }

  const alignRecord: ReviewRecord = {
    runId, stage: 'align', targetRefs: [{ id: artifact.id, entityVersion: 1 }],
    dependencyDigest: '', artifactHash,
    contractHash: input.contractHash, policyHash: input.policyHash,
    reviewerConfigHash: input.reviewerConfigHash, promptHash: alignPromptHash,
    inputHash, status: 'completed', inputTokens: alignRaw.inputTokens, outputTokens: alignRaw.outputTokens,
    startedAt: alignStart, endedAt: new Date().toISOString(), response: alignResponse,
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
    extractionRecord, alignRecord, findings, extractedAtomicClaims,
    newClaimProposals, needsReview: newCoreDiscovered,
    metrics: { extractedAtomicClaims: extractedCount, mappedAtomicClaims: mappedCount },
  }
}

/**
 * Validate the extract response (§12): every span must exactly match the
 * stripped artifact and fall inside its target unit, EXCEPT a
 * boundary-crossing sentence at the unit's end may extend into the following
 * context. Deduplicates by span/text.
 */
export function validateExtractItems(items: unknown, strippedText: string, units: ExtractionUnit[]): ExtractedItem[] {
  if (!Array.isArray(items)) throw new AuditInvalidError('extract response is not {items: [...]}')
  const out: ExtractedItem[] = []
  const seen = new Set<string>()
  for (const raw of items) {
    const item = raw as ExtractedItem
    if (typeof item?.span?.start !== 'number' || typeof item?.span?.end !== 'number'
      || typeof item.exactText !== 'string' || !Array.isArray(item.atomicClaims) || item.atomicClaims.length === 0) {
      throw new AuditInvalidError('extracted item is missing span/exactText/atomicClaims/isQuotation')
    }
    const { start, end } = item.span
    if (start < 0 || start >= end || end > strippedText.length) {
      throw new AuditInvalidError(`extracted span out of bounds: ${JSON.stringify(item.span)}`)
    }
    if (strippedText.slice(start, end) !== item.exactText) {
      throw new AuditInvalidError(`extracted span does not exactly match the artifact: ${JSON.stringify(item.span)}`)
    }
    const unit = units.find((u) => start >= u.span.start && start < u.span.end)
    if (unit === undefined) throw new AuditInvalidError(`extracted span start ${start} is not inside any extraction unit`)
    const withinTarget = end <= unit.span.end
    const boundaryCrossing = end > unit.span.end && end <= unit.context.end
    if (!withinTarget && !boundaryCrossing) {
      throw new AuditInvalidError(`extracted span crosses its unit boundary without a boundary sentence`)
    }
    const key = `${start}:${end}:${item.exactText}`
    if (seen.has(key)) continue // dedup by span/text (§12)
    seen.add(key)
    out.push(item)
  }
  return out
}

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
    if (!expected.has(entry.extractedId)) throw new AuditInvalidError(`alignment references unknown extractedId ${entry.extractedId}`)
    if (seen.has(entry.extractedId)) throw new AuditInvalidError(`extracted item aligned twice: ${entry.extractedId}`)
    seen.add(entry.extractedId)
    if (entry.relation === 'new') {
      if (entry.claimIds.length > 0) throw new AuditInvalidError('relation new must have empty claimIds')
      continue
    }
    if (entry.claimIds.length === 0) throw new AuditInvalidError(`relation ${entry.relation} requires non-empty claimIds`)
    for (const id of entry.claimIds) {
      if (!known.has(id)) throw new AuditInvalidError(`alignment references unknown claim ${id}`)
    }
  }
  for (const id of expected) {
    if (!seen.has(id)) throw new AuditInvalidError(`extracted item missing from alignment: ${id}`)
  }
}
