import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { verifyReceipt } from '../src/verifier.ts'
import { renderReceipt } from '../src/receipt.ts'
import type { Receipt } from '../src/receipt.ts'

/** Deterministic char-count estimate stub (Phase 0: no tokenMeter service). */
const estimate = (t: string): number => t.length

/** Loads the golden fixture captured from this repo's real failing vitest run. */
const goldenLog = readFileSync(new URL('./fixtures/vitest-fail.log.txt', import.meta.url), 'utf8')
const goldenReceipt = JSON.parse(readFileSync(new URL('./fixtures/receipt.json', import.meta.url), 'utf8')) as Receipt

describe('verifier accepts the golden fixture (§4 Phase 0)', () => {
  it('accepts a hand-written receipt against the real failing log', () => {
    expect(verifyReceipt(goldenLog, goldenReceipt, true, estimate)).toEqual({ ok: true })
  })
})

describe('verifier rejection matrix (§3.4)', () => {
  it('rejects a quote not present in the view', () => {
    const r: Receipt = { ...goldenReceipt, failures: [{ name: 'x', evidence: 'this string appears nowhere in the golden log' }] }
    expect(verifyReceipt(goldenLog, r, true, estimate)).toEqual({ ok: false, reason: 'quote' })
  })

  it('rejects a quote shortened under 8 chars', () => {
    const r: Receipt = { ...goldenReceipt, key_output: ['FAIL  1'] }
    expect(verifyReceipt(goldenLog, r, true, estimate)).toEqual({ ok: false, reason: 'quote' })
  })

  it('rejects a vacuous match attempt (short, though the log contains it)', () => {
    // "FAIL" is present in the log but is a vacuous locator — the 8-char floor stops it.
    const r: Receipt = { ...goldenReceipt, key_output: ['FAIL'] }
    expect(verifyReceipt(goldenLog, r, true, estimate)).toEqual({ ok: false, reason: 'quote' })
  })

  it('rejects exit.ok disagreeing with isError (claims ok on error)', () => {
    const r: Receipt = { ...goldenReceipt, exit: { ok: true } }
    expect(verifyReceipt(goldenLog, r, true, estimate)).toEqual({ ok: false, reason: 'exit' })
  })

  it('rejects exit.ok disagreeing with isError (claims failure on success)', () => {
    const view = 'Command ran fine. Tests: 12 passed, 0 failed. All good here.'
    const r: Receipt = { v: 1, cmd: 'pnpm test', exit: { ok: false }, failures: [], key_output: [] }
    expect(verifyReceipt(view, r, false, estimate)).toEqual({ ok: false, reason: 'exit' })
  })

  it('rejects exit.code claimed but unverifiable (no tail match)', () => {
    const r: Receipt = { ...goldenReceipt, exit: { ok: false, code: 1 } }
    expect(verifyReceipt(goldenLog, r, true, estimate)).toEqual({ ok: false, reason: 'exit' })
  })

  it('accepts exit.code when the tail verifiably carries it', () => {
    const view = 'make all\nmake: *** [target] Error 2\nCompilation failed with a fatal problem indeed.'
    const r: Receipt = { v: 1, cmd: 'make', exit: { ok: false, code: 2 }, failures: [], key_output: [] }
    expect(verifyReceipt(view, r, true, estimate)).toEqual({ ok: true })
  })

  it('rejects exit.code when the tail carries a DIFFERENT number', () => {
    const view = 'some output\nexited with code 3\nmore trailing diagnostics follow right here.'
    const r: Receipt = { v: 1, cmd: 'x', exit: { ok: false, code: 1 }, failures: [], key_output: [] }
    expect(verifyReceipt(view, r, true, estimate)).toEqual({ ok: false, reason: 'exit' })
  })

  it('accepts an absent code when no tail match exists (golden case)', () => {
    // The golden log has no "exit code N" line; the receipt's exit.code is absent.
    expect(goldenReceipt.exit).toEqual({ ok: false })
    expect(verifyReceipt(goldenLog, goldenReceipt, true, estimate)).toEqual({ ok: true })
  })

  it('rejects when the receipt is not smaller than minSavingsRatio × the VIEW', () => {
    const flat = (): number => 100
    // estimate(receipt) = 100 >= 0.5 * estimate(view) = 50 → no gain.
    expect(verifyReceipt(goldenLog, goldenReceipt, true, flat)).toEqual({ ok: false, reason: 'size' })
  })

  it('sizes the receipt against the VIEW, not the original source (§3.4.4)', () => {
    // 80-char view; receipt rendering (46 chars) exceeds 0.5 × 80 → size.
    const view = `aaaaaaaaaaaaaaaa${'x'.repeat(64)}`
    const r: Receipt = { v: 1, cmd: 'cmd', exit: { ok: false }, failures: [{ name: 'n', evidence: 'aaaaaaaaaaaaaaaa' }], key_output: [] }
    expect(estimate(renderReceipt(r))).toBeGreaterThan(0.5 * estimate(view))
    expect(verifyReceipt(view, r, true, estimate)).toEqual({ ok: false, reason: 'size' })
  })

  it('rejects counts.fail !== failures.length', () => {
    const r: Receipt = { ...goldenReceipt, counts: { pass: 0, fail: 9, skip: 0 } }
    expect(verifyReceipt(goldenLog, r, true, estimate)).toEqual({ ok: false, reason: 'counts' })
  })

  it('rejects unknown keys at the root', () => {
    expect(verifyReceipt(goldenLog, { ...goldenReceipt, bogus: 1 }, true, estimate)).toEqual({ ok: false, reason: 'schema' })
  })

  it('rejects unknown keys inside failures[]', () => {
    const r = { ...goldenReceipt, failures: [{ ...goldenReceipt.failures[0], bogus: 1 }] }
    expect(verifyReceipt(goldenLog, r, true, estimate)).toEqual({ ok: false, reason: 'schema' })
  })

  it('rejects a schema-invalid receipt outright', () => {
    expect(verifyReceipt(goldenLog, null, true, estimate)).toEqual({ ok: false, reason: 'schema' })
  })

  it('honors a custom minSavingsRatio', () => {
    // Golden receipt render is 498 chars vs the 2098-char log (ratio ≈ 0.237):
    // default 0.5 accepts, but 0.1 must reject.
    expect(verifyReceipt(goldenLog, goldenReceipt, true, estimate)).toEqual({ ok: true })
    const r1 = verifyReceipt(goldenLog, goldenReceipt, true, estimate, { minSavingsRatio: 0.23 })
    expect(r1).toEqual({ ok: false, reason: 'size' })
    // And a 70-char view with a 46-char render: 0.5 rejects (46 >= 35), 0.7 accepts (46 < 49).
    const view = `aaaaaaaaaaaaaaaa${'x'.repeat(54)}`
    const small: Receipt = { v: 1, cmd: 'cmd', exit: { ok: false }, failures: [{ name: 'n', evidence: 'aaaaaaaaaaaaaaaa' }], key_output: [] }
    expect(verifyReceipt(view, small, true, estimate)).toEqual({ ok: false, reason: 'size' })
    expect(verifyReceipt(view, small, true, estimate, { minSavingsRatio: 0.7 })).toEqual({ ok: true })
  })
})
