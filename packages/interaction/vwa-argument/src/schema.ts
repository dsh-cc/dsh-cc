/**
 * Ajv 8 (strict, Draft 2020-12) validation entry for the vwa-argument
 * contracts (design docs/plans/2026-10-16-vwa-evidence-argument.md §25):
 * `strict`, `coerceTypes:false`, `useDefaults:false`,
 * `removeAdditional:false` — unknown fields are errors, never dropped.
 *
 * UUID/Hash/Span rules are the explicit schema patterns of §4/§25, not
 * format assertions (formats are never silently trusted here). UTF-16
 * code-unit limits are schema `maxLength` PLUS the runtime helpers
 * ({@link spanInString}, {@link codeUnitLength}) because JS string
 * `.length` is the normative UTF-16 count (§4).
 *
 * `stableJson`/`sha256Hex` are re-exported from `@dsh-cc/vwa-evidence`
 * (§3: one-way dependency, no duplication).
 *
 * @module @dsh-cc/vwa-argument/schema
 */

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020'
import authorSchemaJson from './contracts/author.schema.json' with { type: 'json' }
import receiptV2SchemaJson from './contracts/receipt-v2.schema.json' with { type: 'json' }
import reviewSchemaJson from './contracts/review.schema.json' with { type: 'json' }
import { sha256Hex, stableJson } from '@dsh-cc/vwa-evidence'
import type { Span } from './types.ts'

export { sha256Hex, stableJson }

/** Strict Ajv instance with the Draft 2020-12 entry point (§25). */
const ajv = new Ajv2020({
  strict: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  allErrors: true,
})

// Register in dependency order so cross-file $refs resolve: author is the
// base vocabulary, review and receipt-v2 reference it by $id.
ajv.addSchema(authorSchemaJson)
ajv.addSchema(reviewSchemaJson)
const receiptCompiled = ajv.compile(receiptV2SchemaJson)

export const validateProjectSnapshot = ajv.getSchema<unknown>(
  'https://dsh-cc.dev/schemas/vwa-argument/author.schema.json#/$defs/ProjectSnapshot',
) ?? (() => { throw new Error('vwa-argument: ProjectSnapshot schema not registered') })()

export const validateReviewResponse = ajv.getSchema<unknown>(
  'https://dsh-cc.dev/schemas/vwa-argument/review.schema.json#/$defs/ReviewResponse',
) ?? (() => { throw new Error('vwa-argument: ReviewResponse schema not registered') })()

export const validateReviewRecord = ajv.getSchema<unknown>(
  'https://dsh-cc.dev/schemas/vwa-argument/review.schema.json#/$defs/ReviewRecord',
) ?? (() => { throw new Error('vwa-argument: ReviewRecord schema not registered') })()

export const validateExtractionRecord = ajv.getSchema<unknown>(
  'https://dsh-cc.dev/schemas/vwa-argument/review.schema.json#/$defs/ExtractionRecord',
) ?? (() => { throw new Error('vwa-argument: ExtractionRecord schema not registered') })()

export const validateExtractedAtomicClaim = ajv.getSchema<unknown>(
  'https://dsh-cc.dev/schemas/vwa-argument/review.schema.json#/$defs/ExtractedAtomicClaim',
) ?? (() => { throw new Error('vwa-argument: ExtractedAtomicClaim schema not registered') })()

export const validateAdjudicationRecord = ajv.getSchema<unknown>(
  'https://dsh-cc.dev/schemas/vwa-argument/review.schema.json#/$defs/AdjudicationRecord',
) ?? (() => { throw new Error('vwa-argument: AdjudicationRecord schema not registered') })()

export const validateAssessment = ajv.getSchema<unknown>(
  'https://dsh-cc.dev/schemas/vwa-argument/review.schema.json#/$defs/Assessment',
) ?? (() => { throw new Error('vwa-argument: Assessment schema not registered') })()

export const validateReceiptV2 = receiptCompiled

/** Lazily compiled per-$defs validators over the author contract (§5: the JSON Schema is the single rule source). */
const authorDefCache = new Map<string, ValidateFunction>()

/** Validate one object against `author.schema.json#/$defs/<def>` (strict Ajv; errors via `.errors`). */
export function authorDefValidator(def: string): ValidateFunction {
  const cached = authorDefCache.get(def)
  if (cached !== undefined) return cached
  const compiled = ajv.compile({ $ref: `https://dsh-cc.dev/schemas/vwa-argument/author.schema.json#/$defs/${def}` })
  authorDefCache.set(def, compiled)
  return compiled
}

/** Collected Ajv error text for one failed author-def validation. */
export function ajvErrors(validate: ValidateFunction): string {
  return (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ''}`).join('; ')
}

/**
 * UTF-16 code-unit length (§4): the normative string limit count, distinct
 * from a grapheme or byte count.
 */
export function codeUnitLength(text: string): number {
  return text.length
}

/**
 * Explicit span rule (§4/§25): 0 <= start < end <= text.length over UTF-16
 * code units. Returns the violation message or '' when the span is valid.
 */
export function spanError(span: Span, text: string): string {
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)) {
    return 'span start/end must be safe integers'
  }
  if (span.start < 0) return 'span start must be >= 0'
  if (span.start >= span.end) return 'span start must be < span end'
  if (span.end > text.length) return `span end ${span.end} exceeds string length ${text.length}`
  return ''
}

/** True when the span slices exactly the given text ({@link spanError} empty). */
export function spanInString(span: Span, text: string): boolean {
  return spanError(span, text) === ''
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Explicit UUID v4 rule (§4): lowercase, variant/Version nibbles checked. */
export function isUuidV4(text: string): boolean {
  return UUID_V4.test(text)
}

/** Explicit prefix+UUID rule (§4). `prefix` excludes the underscore, e.g. 'cl'. */
export function isPrefixedId(text: string, prefix: string): boolean {
  return text.startsWith(`${prefix}_`) && isUuidV4(text.slice(prefix.length + 1))
}

const HASH_RE = /^[0-9a-f]{64}$/

/** Explicit Hash rule (§4): SHA-256, lowercase, 64 hex characters. */
export function isHash(text: string): boolean {
  return HASH_RE.test(text)
}
