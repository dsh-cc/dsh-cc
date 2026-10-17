/** Markdown extraction coordinates, strict response validation and independent reviewer inputs. */
import { rootBlocks } from './review-plan.ts'
import { reviewDefValidator, ajvErrors, spanError } from './schema.ts'
import type { ExtractedItem, Span, Id, ProjectSnapshot } from './types.ts'
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
function splitOverLong(
  start: number,
  end: number,
  body: string,
  maxUnitChars: number,
): { start: number; end: number }[] {
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
    const pieces =
      block.body.length <= maxUnitChars
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
  units: {
    unitId: string
    span: Span
    text: string
    context: { start: number; end: number }
    heading?: { level: number; text: string }
  }[]
  budget: { maxOutputTokens: number }
}

/** Envelope for the align-stage call (§11.4). */
export interface AlignEnvelope {
  stage: 'align'
  runId: Id
  taskId: string
  rubricVersion: string
  contract: ProjectSnapshot['contract']
  items: {
    extractedId: Id
    span: Span
    quote: string
    atomicClaims: { text: string; kind: string; importance: string; scope?: import('./types.ts').Scope }[]
    isQuotation: boolean
  }[]
  claims: {
    id: Id
    text: string
    kind: string
    importance: string
    stance: string
    scope?: import('./types.ts').Scope
  }[]
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
          span: {
            type: 'object',
            additionalProperties: false,
            required: ['start', 'end'],
            properties: { start: { type: 'integer' }, end: { type: 'integer' } },
          },
          exactText: { type: 'string', minLength: 1, maxLength: 12000 },
          atomicClaims: {
            type: 'array',
            minItems: 1,
            maxItems: 1000,
            items: {
              type: 'object',
              additionalProperties: false,
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
export function parseExtractResponse(raw: string): unknown {
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

export function validateExtractItems(items: unknown, strippedText: string, units: ExtractionUnit[]): ExtractedItem[] {
  if (!Array.isArray(items)) throw new AuditInvalidError('extract response is not {items: [...]}')
  const out: ExtractedItem[] = []
  const seen = new Set<string>()
  for (const raw of items) {
    const check = reviewDefValidator('ExtractedItem')
    if (!check(raw)) throw new AuditInvalidError(`extract response schema mismatch: ${ajvErrors(check)}`)
    const item = raw as ExtractedItem
    const spanProblem = spanError(item.span, strippedText)
    if (spanProblem) throw new AuditInvalidError(spanProblem)
    if (
      typeof item?.span?.start !== 'number' ||
      typeof item?.span?.end !== 'number' ||
      typeof item.exactText !== 'string' ||
      !Array.isArray(item.atomicClaims) ||
      item.atomicClaims.length === 0
    ) {
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
    if (unit === undefined)
      throw new AuditInvalidError(`extracted span start ${start} is not inside any extraction unit`)
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
