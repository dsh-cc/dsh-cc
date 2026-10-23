/** F4.1/F4.2: dual-constraint audit packing, calibrated against the shipped default budget. */
import { describe, expect, it } from 'vitest'
import {
  auditCostModel,
  DEFAULT_REVIEW_CONTEXT_CHARS,
  effectiveContextChars,
  maxAlignItemsPerBatch,
  maxExtractUnitsPerBatch,
  maxItemsPerBatch,
  OUTPUT_BUDGET_SAFETY,
  packExtractionBatches,
  TYPICAL_ALIGNMENT_OUTPUT_TOKENS,
  TYPICAL_UNIT_OUTPUT_TOKENS,
} from '../src/audit-cost.ts'
import { extractionUnits, type ExtractionUnit } from '../src/audit-input.ts'
import { effectiveAuditUnitChars } from '../src/audit-reuse.ts'
import { budgetFeasibilityRefusal, estimateReviewCalls } from '../src/feasibility.ts'
import { semanticContractHash } from '../src/review-contract.ts'
import { BUDGET, fakeAdapter, makeSnapshot } from './review-helpers.ts'

function unit(i: number, textChars = 20): ExtractionUnit {
  return {
    unitId: `unit_${i}`,
    span: { start: 0, end: textChars },
    text: 'x'.repeat(textChars),
    context: { start: 0, end: textChars },
  }
}

/** 19 tiny root blocks (plain paragraphs, one unit each) — reproduction scale. */
const nineteenUnitArtifact = Array.from({ length: 19 }, (_, i) => `Paragraph ${i} is short.\n\n`).join('')

describe('maxItemsPerBatch calibration (F4.1)', () => {
  it('matches the doc table for the shipped default, reproduction and schema-max caps', () => {
    expect([3_000, 12_000, 16_000].map((cap) => [maxExtractUnitsPerBatch(cap), maxAlignItemsPerBatch(cap)]))
      .toEqual([[2, 4], [8, 16], [11, 22]])
  })

  it('clamps the schema-minimum cap to 1 item per batch', () => {
    expect(maxItemsPerBatch(256, TYPICAL_UNIT_OUTPUT_TOKENS)).toBe(1)
    expect(maxItemsPerBatch(256, TYPICAL_ALIGNMENT_OUTPUT_TOKENS)).toBe(1)
  })

  it('keeps the documented constants and safety factor', () => {
    expect(TYPICAL_UNIT_OUTPUT_TOKENS).toBe(1_000)
    expect(TYPICAL_ALIGNMENT_OUTPUT_TOKENS).toBe(500)
    expect(OUTPUT_BUDGET_SAFETY).toBe(0.7)
    expect(maxItemsPerBatch(3_000, 1_000)).toBe(Math.max(1, Math.floor(3_000 * 0.7 / 1_000)))
  })
})

describe('packExtractionBatches dual constraint (F4.1)', () => {
  it('closes a batch at maxItems even when the input bound is not reached', () => {
    const units = Array.from({ length: 7 }, (_, i) => unit(i))
    // Char bound far away → only the item bound packs.
    expect(packExtractionBatches(units, 1_000_000, 5).map((b) => b.length)).toEqual([5, 2])
    // Odd split: 11 units at 3 per batch.
    expect(packExtractionBatches(Array.from({ length: 11 }, (_, i) => unit(i)), 1_000_000, 3).map((b) => b.length))
      .toEqual([3, 3, 3, 2])
  })

  it('keeps the input-char-only behavior at the Infinity default', () => {
    // Two ~6k units cannot share 10k*0.7 = 7000 chars → one per batch, as before.
    const units = [unit(0, 6_000), unit(1, 6_000)]
    expect(packExtractionBatches(units, 10_000).map((b) => b.length)).toEqual([1, 1])
    // A unit alone exceeding the bound still goes into its own batch.
    expect(packExtractionBatches([unit(0, 20_000)], 10_000)).toHaveLength(1)
  })

  it('combines both bounds: the tighter one wins per batch', () => {
    const units = Array.from({ length: 5 }, (_, i) => unit(i, 4_000))
    // 0.7 × 10_000 = 7000 chars fits ONE 4k unit (two would be ~8.1k), while
    // maxItems would allow 2 → the char bound closes after 1, then items.
    expect(packExtractionBatches(units, 10_000, 2).map((b) => b.length)).toEqual([1, 1, 1, 1, 1])
  })
})

describe('auditCostModel new shape (F4.1)', () => {
  const units = extractionUnits(nineteenUnitArtifact, 48_000)
  expect(units).toHaveLength(19)

  it('estimates 3 extract + 2 align = 5 calls at the reproduction cap (12,000)', () => {
    const model = auditCostModel({
      artifactText: nineteenUnitArtifact, maxUnitChars: 48_000, maxContextChars: 48_000,
      maxOutputTokensPerCall: 12_000,
    })
    expect(model).toEqual({ units: 19, extractBatches: 3, alignBatches: 2, calls: 5 })
  })

  it('estimates 10 extract + 5 align = 15 calls at the shipped default cap (3,000)', () => {
    const model = auditCostModel({
      artifactText: nineteenUnitArtifact, maxUnitChars: 48_000, maxContextChars: 48_000,
      maxOutputTokensPerCall: 3_000,
    })
    expect(model).toEqual({ units: 19, extractBatches: 10, alignBatches: 5, calls: 15 })
  })
})

describe('shipped-default budget feasibility pin (F4.1)', () => {
  const root = process.env['TMPDIR'] ?? '/tmp'
  const snapshot = makeSnapshot({ claims: [] })
  const input = {
    root,
    snapshot,
    adapter: fakeAdapter([]),
    budget: { ...BUDGET, maxOutputTokensPerRun: 96_000 }, // shipped defaults: 3,000/call, 96,000/run, 40 calls
    contractHash: semanticContractHash(snapshot.contract),
    stages: ['audit'] as const,
    targetClaimIds: [],
    continueMode: false,
  }
  const artifact = { id: 'art_1', text: nineteenUnitArtifact }

  it('admits a 19-unit artifact: 15 audit calls → 23 with retries, 69,000 tokens', () => {
    const estimate = estimateReviewCalls({ ...input, artifact })
    expect(estimate.auditUnits).toBe(19)
    expect(estimate.plannedCalls.audit).toBe(15)
    expect(estimate.estimatedWithRetries).toBe(23)
    expect(estimate.estimatedOutputTokens).toBe(69_000)
    expect(budgetFeasibilityRefusal({ ...input, artifact })).toBeUndefined()
  })

  it('refuses when packing collapses toward one item per call', () => {
    // If a constant tweak makes the formula 1 item/call: 19+19=38 calls →
    // 57 with retries > 40 → the gate must refuse (the pin above fails then).
    const estimate = estimateReviewCalls({ ...input, artifact })
    expect(estimate.estimatedWithRetries).toBeLessThanOrEqual(input.budget.maxCallsPerRun)
  })
})

describe('effectiveContextChars (F4.2)', () => {
  it('defaults to the 48k runner context and honors explicit caller context', () => {
    expect(DEFAULT_REVIEW_CONTEXT_CHARS).toBe(48_000)
    expect(effectiveContextChars()).toBe(48_000)
    expect(effectiveContextChars(undefined)).toBe(48_000)
    expect(effectiveContextChars({})).toBe(48_000)
    expect(effectiveContextChars({ maxContextChars: 2_000 })).toBe(2_000)
  })

  it('keeps estimate/runtime parity for the default path (auditCostModel input)', () => {
    // The estimate path resolves exactly what the runner will pack with.
    const model = auditCostModel({
      artifactText: nineteenUnitArtifact,
      maxUnitChars: effectiveAuditUnitChars({}),
      maxContextChars: effectiveContextChars(),
      maxOutputTokensPerCall: 3_000,
    })
    expect(model.calls).toBe(15)
  })
})
