/**
 * Shared audit cost model (design
 * docs/plans/2026-10-21-vwa-feasibility-runtime-alignment.md §F1.1): the
 * batch-packing semantics of the audit runner and the static feasibility
 * estimate live HERE so the two cannot diverge.
 *
 * @module @dsh-cc/vwa-argument/audit-cost
 */
import { stableJson } from './schema.ts'
import { extractionUnits, stripClaimMarkers, type ExtractionUnit } from './audit-input.ts'

/** F4.2: runner-effective review context (ReviewCaller's 48,000-char gate). */
export const DEFAULT_REVIEW_CONTEXT_CHARS = 48_000
/** F4.2: estimate/runtime context parity — both resolve through this helper. */
export const effectiveContextChars = (caller?: { maxContextChars?: number }) =>
  caller?.maxContextChars ?? DEFAULT_REVIEW_CONTEXT_CHARS

/** Per-unit extract response estimate. Anchors: the measured 23,979 tokens /
 * 19 units ≈ 1,262 tokens/unit is a LOWER bound (that call truncated); 1,000
 * is the conservative packing target, with bisect (F4.2) covering the miss. */
export const TYPICAL_UNIT_OUTPUT_TOKENS = 1_000
/** Per-item align response estimate (relation + claimIds + a short rationale;
 * the 4,000-char rationale cap is the worst case, not the typical). */
export const TYPICAL_ALIGNMENT_OUTPUT_TOKENS = 500
/** Headroom on the per-call output cap (same family as the 0.7 input factor). */
export const OUTPUT_BUDGET_SAFETY = 0.7

/** Dual-constraint packing: items per batch so the typical OUTPUT fits the
 * per-call cap with headroom (F4.1). */
export function maxItemsPerBatch(maxOutputTokensPerCall: number, typicalOutputTokens: number): number {
  return Math.max(1, Math.floor((maxOutputTokensPerCall * OUTPUT_BUDGET_SAFETY) / typicalOutputTokens))
}
export const maxExtractUnitsPerBatch = (cap: number) => maxItemsPerBatch(cap, TYPICAL_UNIT_OUTPUT_TOKENS)
export const maxAlignItemsPerBatch = (cap: number) => maxItemsPerBatch(cap, TYPICAL_ALIGNMENT_OUTPUT_TOKENS)

/**
 * Pack extraction units into dispatch batches, one batch = one model call.
 * Verbatim move of the audit.ts packing loop: a unit's cost is
 * `stableJson(unit).length` measured WITHOUT the `before`/`after` context
 * fields, and a batch fits `0.7 × maxContextChars` of that measure. F4.1: a
 * batch ALSO closes at `maxItems` units so its typical OUTPUT cannot exceed
 * `maxOutputTokensPerCall`; a unit that alone exceeds the input bound still
 * goes into its own batch (unchanged no-re-measure behavior).
 */
export function packExtractionBatches(
  units: ExtractionUnit[],
  maxContextChars: number,
  maxItems = Number.POSITIVE_INFINITY,
): ExtractionUnit[][] {
  const batches: ExtractionUnit[][] = []
  let batch: ExtractionUnit[] = [],
    chars = 0
  for (const unit of units) {
    if (batch.length && (chars + stableJson(unit).length > maxContextChars * 0.7 || batch.length >= maxItems)) {
      batches.push(batch)
      batch = []
      chars = 0
    }
    batch.push(unit)
    chars += stableJson(unit).length
  }
  if (batch.length || batches.length === 0) batches.push(batch)
  return batches
}

/**
 * Static audit cost: extraction unit count, dispatch batch counts and total
 * model calls (extract batches + align batches, F4.1). `maxContextChars` MUST
 * be the RUNNER's effective context (`effectiveContextChars`), never
 * `Infinity` — an unbounded no-op default must not leak into estimates.
 *
 * `extractBatches` is EXACT (the runtime packs the same units with the same
 * two constraints). `alignBatches` is an APPROXIMATION: the runtime chunks
 * align by the number of EXTRACTED ITEMS, while this model can only key on
 * extraction units — one unit may yield several items or none. Direction of
 * the error, both bounded and both acceptable under the "reservation upper
 * bound" semantics of the feasibility gate:
 *  - over-estimate (many units, few items) → an early, conservative
 *    BUDGET_INSUFFICIENT refusal;
 *  - under-estimate (few units, many items) → extra runtime dispatches, which
 *    the per-run BudgetTracker enforces (BUDGET_EXHAUSTED with completed
 *    records preserved) and the truncation bisect covers.
 * It is NOT a hard feasibility guarantee for align.
 */
export function auditCostModel(input: {
  artifactText: string
  maxUnitChars: number
  maxContextChars: number
  maxOutputTokensPerCall: number
}): { units: number; extractBatches: number; alignBatches: number; calls: number } {
  const stripped = stripClaimMarkers(input.artifactText).text
  const units = extractionUnits(stripped, input.maxUnitChars)
  const extractBatches = packExtractionBatches(
    units, input.maxContextChars, maxExtractUnitsPerBatch(input.maxOutputTokensPerCall),
  ).length
  const alignBatches = packExtractionBatches(
    units, input.maxContextChars, maxAlignItemsPerBatch(input.maxOutputTokensPerCall),
  ).length
  return { units: units.length, extractBatches, alignBatches, calls: extractBatches + alignBatches }
}
