import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { validateExtractItems, extractionUnits } from '../src/audit.ts'
import type { Scope } from '../src/types.ts'
import { makeClaim } from './review-helpers.ts'
const text = 'A fact.'
const item = {
  span: { start: 0, end: text.length },
  exactText: text,
  isQuotation: false,
  atomicClaims: [{ text, kind: 'fact', scope: makeClaim().scope, importance: 'core' }],
}

const units = extractionUnits(text, 1000)
const DEFAULT_SCOPE: Scope = {
  subject: 'unspecified',
  corpus: [],
  time: 'unspecified',
  geography: 'unspecified',
  exclusions: [],
}

/** One extract item whose single atomic claim carries an arbitrary raw `scope`. */
function itemWithScope(scope: unknown): Record<string, unknown> {
  return {
    span: { start: 0, end: text.length },
    exactText: text,
    isQuotation: false,
    atomicClaims: [{ text, kind: 'fact', scope, importance: 'core' }],
  }
}

function scopeOf(raw: Record<string, unknown>): Scope {
  return validateExtractItems([raw], text, units)[0]!.atomicClaims[0]!.scope
}

describe('extract responses are validated as strictly as other reviewer outputs', () => {
  it('rejects a missing boolean rather than treating it as false', () => {
    const { isQuotation, ...missing } = item
    expect(() => validateExtractItems([missing], text, extractionUnits(text, 1000))).toThrow()
  })
  it('rejects fractional UTF-16 offsets', () => {
    expect(() =>
      validateExtractItems([{ ...item, span: { start: 0.1, end: text.length } }], text, extractionUnits(text, 1000)),
    ).toThrow()
  })
  it('rejects fabricated claim kinds and unknown fields', () => {
    expect(() =>
      validateExtractItems(
        [{ ...item, atomicClaims: [{ ...item.atomicClaims[0], kind: 'proven-fact' }] }],
        text,
        extractionUnits(text, 1000),
      ),
    ).toThrow()
    expect(() => validateExtractItems([{ ...item, trusted: true }], text, extractionUnits(text, 1000))).toThrow()
  })
})

describe('extract scope normalization: lenient in, strict out', () => {
  it('defaults a missing, empty or non-object scope to the five-field default', () => {
    for (const scope of [undefined, {}, 'text', 42, ['a'], null]) {
      expect(scopeOf(itemWithScope(scope))).toEqual(DEFAULT_SCOPE)
    }
  })

  it('preserves a stated key and defaults the rest; numeric values are not coerced', () => {
    expect(scopeOf(itemWithScope({ time: '2020–2024' }))).toEqual({ ...DEFAULT_SCOPE, time: '2020–2024' })
    expect(scopeOf(itemWithScope({ time: 2024 }))).toEqual(DEFAULT_SCOPE)
  })

  it('defaults whitespace-only strings after trimming', () => {
    const scope = scopeOf(itemWithScope({ subject: '  ', time: '\t\n', geography: '   ' }))
    expect(scope.subject).toBe('unspecified')
    expect(scope.time).toBe('unspecified')
    expect(scope.geography).toBe('unspecified')
  })

  it('drops unknown keys and never trusts a model-supplied corpus (even well-formed ids)', () => {
    const hallucinated = `src_${randomUUID()}`
    const scope = scopeOf(
      itemWithScope({ subject: 's', corpus: [hallucinated, 'nonsense'], extra: 'dropped' }),
    )
    expect(scope).toEqual({ ...DEFAULT_SCOPE, subject: 's' })
  })

  it('filters exclusions to strings then slices to 1000; non-arrays become empty arrays', () => {
    const exclusions = [
      ...Array.from({ length: 1200 }, (_, i) => `e${i}`),
      ...Array.from({ length: 300 }, (_, i) => i),
    ]
    const scope = scopeOf(itemWithScope({ exclusions }))
    expect(scope.exclusions).toHaveLength(1000)
    expect(scope.exclusions[0]).toBe('e0')
    expect(scope.exclusions[999]).toBe('e999')
    expect(scopeOf(itemWithScope({ exclusions: 'not-an-array' })).exclusions).toEqual([])
    expect(scopeOf(itemWithScope({ corpus: 'not-an-array' })).corpus).toEqual([])
  })

  it('is idempotent across the truncation boundary and on canonical values', () => {
    const boundary = `${'a'.repeat(511)} x`
    const once = scopeOf(itemWithScope({ subject: boundary, exclusions: [boundary] }))
    expect(once.subject).toBe('a'.repeat(511))
    const twice = validateExtractItems(
      [itemWithScope(once)],
      text,
      units,
    )[0]!.atomicClaims[0]!.scope
    expect(twice).toEqual(once)
    expect(scopeOf(itemWithScope(DEFAULT_SCOPE))).toEqual(DEFAULT_SCOPE)
  })

  it('never aliases corpus/exclusions arrays between normalized claims', () => {
    const raw = {
      span: { start: 0, end: text.length },
      exactText: text,
      isQuotation: false,
      atomicClaims: [
        { text: 'first', kind: 'fact', scope: {}, importance: 'core' },
        { text: 'second', kind: 'fact', scope: {}, importance: 'core' },
      ],
    }
    const [validated] = validateExtractItems([raw], text, units)
    const [a, b] = validated!.atomicClaims
    expect(a!.scope.corpus).not.toBe(b!.scope.corpus)
    expect(a!.scope.exclusions).not.toBe(b!.scope.exclusions)
  })

  it('does not bypass the strict validator: an over-long text still throws', () => {
    const raw = itemWithScope({})
    ;(raw.atomicClaims as { text: string }[])[0]!.text = 'x'.repeat(2001)
    expect(() => validateExtractItems([raw], text, units)).toThrow(/extract response schema mismatch/)
  })
})
