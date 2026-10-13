/**
 * Prose-mask pins (§4.2): markers and claims are recognized ONLY in prose —
 * never inside fenced blocks or inline code spans.
 */

import { describe, expect, it } from 'vitest'
import { extractClaims, findMarkers, proseMask } from '../src/marker.ts'

describe('proseMask (length-preserving §4.2)', () => {
  it('leaves prose untouched at identical offsets', () => {
    expect(proseMask('hello 〔src:ws:docs/a.md#L1-L2〕')).toBe('hello 〔src:ws:docs/a.md#L1-L2〕')
  })

  it('masks fenced code and inline code spans, preserving length', () => {
    const text = 'a\n```\nb\n```\n'
    expect(proseMask(text)).toBe('a\n   \n \n   \n')
    expect(proseMask(text)).toHaveLength(text.length)
  })

  it('finds markers ONLY in prose', () => {
    const text =
      'prose 〔src:ws:docs/a.md#L1-L2〕 here\n```\ncode 〔src:ws:docs/a.md#L1-L2〕\n```\n`code 〔src:ws:docs/a.md#L1-L2〕` tail'
    expect(findMarkers(proseMask(text))).toHaveLength(1)
  })

  it('a marker alone makes a sentence a claim even without detector hits', () => {
    const { claims } = extractClaims('see 〔src:ws:docs/a.md#L1-L2〕 now')
    expect(claims).toHaveLength(1)
    expect(claims[0]?.markers[0]?.parsed).toBe(true)
  })
})
