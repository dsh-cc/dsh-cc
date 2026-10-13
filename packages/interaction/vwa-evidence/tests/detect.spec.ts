/**
 * FROZEN four-family claim-detection pins (§4.2) plus marker syntax,
 * prose-only recognition, sentence boundaries, and UTF-16 span indexing.
 * Every regex below has a pinned positive AND negative case.
 */

import { describe, expect, it } from 'vitest'
import {
  CLAIM_DETECTORS,
  IDENTIFIER_DETECTORS,
  extractClaims,
  findMarkers,
  parseMarkerInner,
  proseMask,
} from '../src/marker.ts'

describe('(a) numbers with units/percentages', () => {
  const re = CLAIM_DETECTORS.numbersWithUnits
  it.each([
    'coverage is 90% of the budget',
    'wait 30s before retrying',
    'the run produced 42 files',
    'a 1.5 MB payload',
    '12 tokens per call',
  ])('positive: %s', text => {
    expect(re.test(text)).toBe(true)
  })
  it.each([
    'there are 5 settings to change', // bare digit without a unit word boundary
    'the 2nd attempt',
    'version 1.2 of the tool',
  ])('negative: %s', text => {
    expect(re.test(text)).toBe(false)
  })
})

describe('(b) ISO dates', () => {
  const re = CLAIM_DETECTORS.isoDate
  it.each(['shipped on 2026-10-12', 'at 2026-10-12T08:30:00Z', 'due 2026-10-12 08:30'])('positive: %s', text => {
    expect(re.test(text)).toBe(true)
  })
  it.each(['the 12-10 date', '2026/10/12', 'in 2026-1-2'])('negative: %s', text => {
    expect(re.test(text)).toBe(false)
  })
})

describe('(c) version strings (v?d+.d+ shape)', () => {
  const re = CLAIM_DETECTORS.versionString
  it.each(['released v1.2', 'requires 3.18.1', 'since v2.0'])('positive: %s', text => {
    expect(re.test(text)).toBe(true)
  })
  it.each([
    'the 10-20 range',
    'v1 alone',
    'chapter 12',
  ])('negative: %s', text => {
    expect(re.test(text)).toBe(false)
  })
})

describe('(d) API/identifier shapes', () => {
  it('call shape xx()', () => {
    expect(IDENTIFIER_DETECTORS.call.test('call encodeSegment() first')).toBe(true)
    expect(IDENTIFIER_DETECTORS.call.test('call encodeSegment(a) with args')).toBe(false)
  })
  it('camelCase and UpperCamelCase', () => {
    expect(IDENTIFIER_DETECTORS.camel.test('the artifactHash field')).toBe(true)
    expect(IDENTIFIER_DETECTORS.camel.test('the ReceiptRow type')).toBe(true)
    expect(IDENTIFIER_DETECTORS.camel.test('plain words only here')).toBe(false)
  })
  it('CONST_CASE', () => {
    expect(IDENTIFIER_DETECTORS.constCase.test('DEFAULT_GATE_TIMEOUT_MS is 30000')).toBe(true)
    expect(IDENTIFIER_DETECTORS.constCase.test('the Word case')).toBe(false)
  })
  it('quoted config keys', () => {
    expect(IDENTIFIER_DETECTORS.quotedKey.test("set 'nudge-budget' to 4")).toBe(true)
    expect(IDENTIFIER_DETECTORS.quotedKey.test('the "Quoted Prose" stays out')).toBe(false)
  })
})

describe('marker syntax (full-width brackets §4.2)', () => {
  it('parses ws: source specs with line ranges', () => {
    expect(parseMarkerInner('src:ws:docs/a.md#L3-L9')).toEqual([{ sourceId: 'ws:docs/a.md', lineStart: 3, lineEnd: 9 }])
  })
  it('joins multiple sources with ;', () => {
    const specs = parseMarkerInner('src:ws:docs/a.md#L1-L2;ws:guide.md#L4-L6')
    expect(specs).toHaveLength(2)
    expect(specs?.[1]?.sourceId).toBe('ws:guide.md')
  })
  it.each(['ws:a.md#L2-L1', 'src:a.md#L1-L2', 'ws:a.md#L0-L2', 'ws:a.md#L1-L0'])('rejects malformed: %s', inner => {
    expect(parseMarkerInner(inner)).toBeNull()
  })
  it('finds markers only in prose (mask)', () => {
    const text = 'prose 〔src:ws:docs/a.md#L1-L2〕 here\n```\ncode 〔src:ws:docs/a.md#L1-L2〕\n```\n`code 〔src:ws:docs/a.md#L1-L2〕` tail'
    const found = findMarkers(proseMask(text))
    expect(found).toHaveLength(1)
  })
})

describe('sentence boundaries and spans', () => {
  it('splits on newline and on .!? plus full-width 。！？', () => {
    const text = 'One two 3 files.\nThree four v1.2！\nFive six 90%？'
    const { claims } = extractClaims(text)
    expect(claims.map(c => c.text)).toEqual(['One two 3 files.', 'Three four v1.2！', 'Five six 90%？'])
  })
  it('spans are UTF-16 code-unit indices — emoji sentinel', () => {
    const text = '🚀 launch in 30s now'
    const { claims } = extractClaims(text)
    const claim = claims[0]
    expect(claim).toBeDefined()
    // 🚀 is 2 UTF-16 code units; the span must index code units, not points.
    expect(text.slice(claim!.span[0], claim!.span[1])).toBe(claim!.text)
    // The whole sentence is one claim starting at the emoji; the (a)-family
    // row pins the code-unit offset (12 instead of 13 would mean code POINTS).
    expect(claim!.span[0]).toBe(0)
    expect(extractClaims(text).numbers[0]?.span).toEqual([13, 16])
  })
  it('claim.text duplicates only the first 200 chars', () => {
    const text = `${'x'.repeat(300)} 42% done.`
    const { claims } = extractClaims(text)
    expect(claims[0]?.text).toHaveLength(200)
  })
  it('a document with no detected claims yields zero claims', () => {
    expect(extractClaims('No facts here, just prose without markers.').claims).toEqual([])
  })
  it('emits (a)-family numbers rows with original-text spans', () => {
    const { numbers } = extractClaims('about 90% coverage')
    expect(numbers).toEqual([{ span: [6, 9], ref: '90%' }])
  })
  it('CJK text detects and indexes correctly', () => {
    const { claims } = extractClaims('覆盖率达到 90% 即可。')
    expect(claims[0]?.text).toBe('覆盖率达到 90% 即可。')
    expect(claims[0]?.span).toEqual([0, 13])
  })
})
