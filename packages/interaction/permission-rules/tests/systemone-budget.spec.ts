import { describe, expect, it } from 'vitest'
import { S1_ENVELOPE_TOKENS, S1_MARGIN_TOKENS, MIN_STATE_TOKENS, capMiddleToTokenBudget, estimateSystemOneTokens } from '../src/systemone-budget.ts'

describe('estimateSystemOneTokens', () => {
  // Calibration fixtures (2026-09-25, orchestrix /v1/systemone, laya-rl-agent).
  it('ASCII word text ≈0.19 tok/char (±15%)', () => {
    const text = 'word '.repeat(246) // 1230 chars of word-text
    const estimate = estimateSystemOneTokens(text)
    expect(estimate / text.length).toBeGreaterThanOrEqual(0.19 * 0.85)
    expect(estimate / text.length).toBeLessThanOrEqual(0.22 * 1.15)
  })

  it('CJK text ≈1.46 tok/char (±10% at weight 1.5)', () => {
    const text = '这是一个用于校准的句子。'.repeat(49) // 588 CJK chars ≈ 882 tokens
    const estimate = estimateSystemOneTokens(text)
    expect(estimate / text.length).toBe(1.5)
    expect(estimate).toBeGreaterThanOrEqual(891 * 0.9)
    expect(estimate).toBeLessThanOrEqual(891 * 1.1)
  })

  it('bash-dense punctuation ≈0.43 tok/char (±15% at weight 0.45)', () => {
    const text = '{a:"b",c:[1,2]};'.repeat(52)
    const estimate = estimateSystemOneTokens(text)
    expect(estimate / text.length).toBeGreaterThanOrEqual(0.43 * 0.85)
    expect(estimate / text.length).toBeLessThanOrEqual(0.47 * 1.15)
  })

  it('base64 payload is a documented underestimate: ≥0.25 tok/char, ≤ measured 0.77', () => {
    const text = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk='.repeat(7)
    const estimate = estimateSystemOneTokens(text)
    expect(estimate / text.length).toBeGreaterThanOrEqual(0.25)
    expect(estimate / text.length).toBeLessThanOrEqual(0.77)
  })

  it('iteration is by codepoint: a surrogate pair counts ONCE at weight 1.5', () => {
    // U+1F600 (4-byte UTF-8, 2 UTF-16 units) — one codepoint, 1.5 tokens.
    const text = '😀'
    expect(text.length).toBe(2) // sanity: it IS a surrogate pair
    expect(estimateSystemOneTokens(text)).toBe(1.5)
    expect(estimateSystemOneTokens(text.repeat(3))).toBe(4.5)
  })

  it('frozen constants keep their doc-frozen values', () => {
    expect(S1_ENVELOPE_TOKENS).toBe(4)
    expect(S1_MARGIN_TOKENS).toBe(16)
    expect(MIN_STATE_TOKENS).toBe(64)
  })
})

describe('capMiddleToTokenBudget', () => {
  const MARKER = '\n[… probe input truncated …]\n'

  it('returns the input verbatim when under budget', () => {
    const text = 'a'.repeat(100)
    expect(capMiddleToTokenBudget(text, 1000, MARKER)).toBe(text)
  })

  it('cuts head 2/3 + tail 1/3 around the marker, within budget', () => {
    const text = 'a'.repeat(2000)
    const out = capMiddleToTokenBudget(text, 100, MARKER)
    expect(out).toContain(MARKER)
    expect(out.startsWith('aaaa')).toBe(true)
    expect(out.endsWith('aaaa')).toBe(true)
    expect(estimateSystemOneTokens(out)).toBeLessThanOrEqual(100)
    // head ≈ 2× tail
    const [head, tail] = out.split(MARKER)
    expect(head!.length / tail!.length).toBeGreaterThan(1.5)
    expect(head!.length / tail!.length).toBeLessThan(2.5)
  })

  it('is codepoint-safe: never splits a surrogate pair', () => {
    const text = ('x'.repeat(30) + '😀').repeat(120)
    const out = capMiddleToTokenBudget(text, 60, MARKER)
    // No lone surrogates anywhere in the output (manual UTF-16 scan — a
    // regex lookahead/lookbehind mis-flags a complete pair at EOL).
    const lone: number[] = []
    for (let i = 0; i < out.length; i += 1) {
      const c = out.charCodeAt(i)
      if (c >= 0xd800 && c <= 0xdbff) {
        if (!(out.charCodeAt(i + 1) >= 0xdc00 && out.charCodeAt(i + 1) <= 0xdfff)) lone.push(i)
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        if (!(out.charCodeAt(i - 1) >= 0xd800 && out.charCodeAt(i - 1) <= 0xdbff)) lone.push(i)
      }
    }
    expect(lone).toEqual([])
    expect(estimateSystemOneTokens(out)).toBeLessThanOrEqual(60)
  })

  it('budget-exhausted extreme: zero budget ⇒ empty string', () => {
    expect(capMiddleToTokenBudget('abcdef', 0, MARKER)).toBe('')
  })

  it('tiny budgets still end with the honest tail (no head-only cut)', () => {
    const out = capMiddleToTokenBudget(`safe ${'y'.repeat(400)}; rm -rf /x`, 40, '…', 2 / 3)
    expect(out.endsWith('; rm -rf /x')).toBe(true)
    expect(estimateSystemOneTokens(out)).toBeLessThanOrEqual(40)
  })
})
