/**
 * D24 (lane-1 side): `〔claim:<id>〕` authoring-aid markers are non-marker
 * text — skipped, no `invalid-marker`, and every character offset stays
 * valid when they are mixed with `src:` markers (design §19, §2 marker row).
 */

import { describe, expect, it } from 'vitest'
import { extractClaims, findMarkers, isClaimMarkerInner, parseMarkerInner } from '../src/marker.ts'

describe('claim markers are non-marker text (D24)', () => {
  it('recognizes the claim:<id> inner shape', () => {
    expect(isClaimMarkerInner('claim:cl_abc')).toBe(true)
    expect(isClaimMarkerInner('src:ws:docs/a.md#L1-L2')).toBe(false)
    expect(isClaimMarkerInner('claim:has space')).toBe(false)
  })

  it('parseMarkerInner still rejects non-src inners (claim markers are skipped upstream, not parsed)', () => {
    expect(parseMarkerInner('claim:cl_abc')).toBeNull()
  })

  it('mixed source + claim markers: no invalid-marker, src markers still parse', () => {
    const text = 'Uses 40% less memory 〔claim:cl_abc〕 and retries after 30s 〔src:ws:docs/a.md#L3-L4〕.'
    const markers = findMarkers(text)
    expect(markers).toHaveLength(1)
    expect(markers[0]!.parsed).toBe(true)
    expect(markers[0]!.specs[0]!.sourceId).toBe('ws:docs/a.md')
  })

  it('offsets are preserved: spans point into the ORIGINAL text', () => {
    const text = ' Uses 40% less memory 〔claim:cl_abc〕 and v1.2 〔src:ws:docs/a.md#L1-L2〕 here.'
    const markers = findMarkers(text)
    const { claims } = extractClaims(text)
    // The src marker span slices exactly the marker text out of the original.
    const marker = markers[0]!
    expect(text.slice(marker.span[0], marker.span[1])).toBe('〔src:ws:docs/a.md#L1-L2〕')
    // Sentences keep their original coordinates; the claim-marker sentence
    // carries no phantom invalid marker.
    const sentence = claims.find((claim) => claim.text.includes('40%'))!
    expect(text.slice(sentence.span[0], sentence.span[1])).toContain('〔claim:cl_abc〕')
    // The sentence attaches only the src marker; the claim marker produced
    // no marker occurrence (neither parsed nor invalid).
    expect(sentence.markers).toHaveLength(1)
    expect(text.slice(sentence.markers[0]!.span[0], sentence.markers[0]!.span[1])).not.toContain('claim:')
  })
})
