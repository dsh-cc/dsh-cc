import { describe, expect, it } from 'vitest'
import { renderReceipt, parseReceipt } from '../src/receipt.ts'
import { buildMarker, parseMarker } from '../src/marker.ts'

const valid = {
  v: 1,
  cmd: 'pnpm test',
  exit: { ok: false },
  failures: [{ name: 'a.spec.ts > case', evidence: 'expected 1 to equal 2' }],
  key_output: ['Test Files  1 failed (1)'],
}

describe('receipt schema (§3.3)', () => {
  it('accepts a well-formed receipt', () => {
    expect(parseReceipt(valid)).toEqual(valid)
  })

  it('accepts optional fields when present', () => {
    const r = {
      ...valid,
      exit: { ok: true, code: 0 },
      counts: { pass: 3, fail: 1, skip: 0 },
    }
    expect(parseReceipt(r)).toEqual(r)
  })

  it('rejects wrong v', () => {
    expect(parseReceipt({ ...valid, v: 2 })).toBeNull()
  })

  it('rejects wrong types at nested levels', () => {
    expect(parseReceipt({ ...valid, exit: { ok: 'yes' } })).toBeNull()
    expect(parseReceipt({ ...valid, failures: 'none' })).toBeNull()
    expect(parseReceipt({ ...valid, key_output: [42] })).toBeNull()
  })

  it('rejects key_output over the 8-entry cap', () => {
    expect(parseReceipt({ ...valid, key_output: Array.from({ length: 9 }, () => 'aaaaaaaa') })).toBeNull()
    expect(parseReceipt({ ...valid, key_output: Array.from({ length: 8 }, () => 'aaaaaaaa') })).toEqual({ ...valid, key_output: Array.from({ length: 8 }, () => 'aaaaaaaa') })
  })

  it('REJECTS unknown keys at every object level (schema does not strip)', () => {
    expect(parseReceipt({ ...valid, bogus: 1 })).toBeNull()
    expect(parseReceipt({ ...valid, exit: { ...valid.exit, bogus: 1 } })).toBeNull()
    expect(parseReceipt({ ...valid, failures: [{ ...valid.failures[0], bogus: 1 }] })).toBeNull()
    expect(parseReceipt({ ...valid, counts: { pass: 1, fail: 1, skip: 0, bogus: 1 } })).toBeNull()
  })
})

describe('renderReceipt (§3.5)', () => {
  it('renders compact deterministic lines without a marker line', () => {
    const body = renderReceipt({
      v: 1,
      cmd: 'pnpm test',
      exit: { ok: false, code: 1 },
      failures: [{ name: 'a > b', evidence: 'expected 1 to equal 2' }],
      key_output: ['Test Files  1 failed (1)'],
      counts: { pass: 3, fail: 1, skip: 0 },
    })
    expect(body).toBe(
      [
        'cmd: pnpm test',
        'exit: failed code 1',
        'FAIL a > b: expected 1 to equal 2',
        'key: Test Files  1 failed (1)',
        'counts: pass=3 fail=1 skip=0',
      ].join('\n'),
    )
    expect(body).not.toContain('[dsh-cc compressed')
  })

  it('omits optional parts deterministically', () => {
    expect(renderReceipt({ ...valid, exit: { ok: true } })).toBe(
      ['cmd: pnpm test', 'exit: ok', 'FAIL a.spec.ts > case: expected 1 to equal 2', 'key: Test Files  1 failed (1)'].join('\n'),
    )
  })
})

describe('receipt + marker round-trip (§3.5 property)', () => {
  const variants = [
    valid,
    { ...valid, exit: { ok: true, code: 0 }, counts: { pass: 9, fail: 0, skip: 2 }, failures: [] },
    { ...valid, failures: [], key_output: [] },
    { ...valid, key_output: Array.from({ length: 8 }, (_, i) => `evidence line number ${i}...`) },
  ]

  it('parseMarker recovers the hash from the trailing buildMarker line', () => {
    const hash = '0123456789abcdef'
    for (const r of variants) {
      const body = renderReceipt(r)
      const last = `${body}\n${buildMarker(12480, 310, hash)}`.split('\n').at(-1)!
      expect(parseMarker(last)).toEqual({ tokensBefore: 12480, tokensAfter: 310, hash })
    }
  })
})
