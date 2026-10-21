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

/**
 * Pack extraction units into dispatch batches, one batch = one model call.
 * Verbatim move of the audit.ts packing loop: a unit's cost is
 * `stableJson(unit).length` measured WITHOUT the `before`/`after` context
 * fields, and a batch fits `0.7 × maxContextChars` of that measure.
 */
export function packExtractionBatches(units: ExtractionUnit[], maxContextChars: number): ExtractionUnit[][] {
  const batches: ExtractionUnit[][] = []
  let batch: ExtractionUnit[] = [],
    chars = 0
  for (const unit of units) {
    if (batch.length && chars + stableJson(unit).length > maxContextChars * 0.7) {
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
 * Static audit cost: extraction unit count, dispatch batch count and total
 * model calls (extract batches + 1 align call). `maxContextChars` MUST be
 * the RUNNER's effective context (e.g. `deps.maxContextChars ?? 48_000`),
 * never `Infinity` — the runtime's `caller?.maxContextChars ?? Infinity`
 * fallback is an unbounded no-op default and must not leak into estimates.
 */
export function auditCostModel(input: {
  artifactText: string
  maxUnitChars: number
  maxContextChars: number
}): { units: number; batches: number; calls: number } {
  const stripped = stripClaimMarkers(input.artifactText).text
  const units = extractionUnits(stripped, input.maxUnitChars)
  const batches = packExtractionBatches(units, input.maxContextChars).length
  return { units: units.length, batches, calls: batches + 1 /* align */ }
}
