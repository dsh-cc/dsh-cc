import { describe, it, expect } from 'vitest'
import { validateExtractItems, extractionUnits } from '../src/audit.ts'
import { makeClaim } from './review-helpers.ts'
const text = 'A fact.'
const item = {
  span: { start: 0, end: text.length },
  exactText: text,
  isQuotation: false,
  atomicClaims: [{ text, kind: 'fact', scope: makeClaim().scope, importance: 'core' }],
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
