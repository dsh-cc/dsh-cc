/**
 * §4.5/§13: stripMarkers — strip cases, both offset maps, endpoint
 * affinity, surrogate pairs, CRLF. Offsets are UTF-16 code units, matching
 * `String.prototype.slice` and the persisted Span coordinates.
 */
import { describe, expect, it } from 'vitest'
import { intersectsRemoved, stripMarkers } from '../src/render.ts'

const SRC = '〔src:ws:docs/a.md#L1-L2〕'
const CLAIM = '〔claim:cl_1〕'

describe('stripMarkers — strip cases', () => {
  it('strips nothing when no marker is present', () => {
    const render = stripMarkers('plain text with [brackets] and 〔unrelated chars〕\n')
    expect(render.text).toBe('plain text with [brackets] and 〔unrelated chars〕\n')
    expect(render.removed).toEqual([])
    for (let offset = 0; offset <= render.text.length; offset++) {
      expect(render.draftToRendered(offset)).toBe(offset)
      expect(render.renderedToDraft(offset)).toBe(offset)
    }
  })

  it('removes src and claim markers anywhere, including inside code spans and fences', () => {
    const draft = `a ${SRC} b\n\n\`\`\`\nx ${CLAIM} y\n\`\`\`\n\`inline ${SRC}\`\n`
    const render = stripMarkers(draft)
    expect(render.text).toBe('a  b\n\n```\nx  y\n```\n`inline `\n')
    expect(render.text).not.toMatch(/〔(?:src|claim):/)
    expect(render.removed).toHaveLength(3)
  })

  it('removes adjacent markers as two ranges', () => {
    const draft = `x${SRC}${CLAIM}y`
    const render = stripMarkers(draft)
    expect(render.text).toBe('xy')
    expect(render.removed).toEqual([
      { start: 1, end: 1 + SRC.length },
      { start: 1 + SRC.length, end: 1 + SRC.length + CLAIM.length },
    ])
    const seam = 1 + SRC.length + CLAIM.length
    // The rendered 'y' maps past BOTH marker ranges.
    expect(render.renderedToDraft(1)).toBe(seam)
    expect(render.draftToRendered(seam)).toBe(1)
  })

  it('removes markers with one-character separation', () => {
    const draft = `${SRC}m${CLAIM}`
    const render = stripMarkers(draft)
    expect(render.text).toBe('m')
    expect(render.renderedToDraft(0)).toBe(SRC.length)
    expect(render.renderedToDraft(1)).toBe(SRC.length + 1 + CLAIM.length)
  })

  it('removes markers at the very start and the very end of the text', () => {
    const render = stripMarkers(`${SRC}body${CLAIM}`)
    expect(render.text).toBe('body')
    expect(render.removed).toEqual([
      { start: 0, end: SRC.length },
      { start: SRC.length + 4, end: SRC.length + 4 + CLAIM.length },
    ])
    expect(render.renderedToDraft(0)).toBe(SRC.length)
    expect(render.renderedToDraft(4)).toBe(`${SRC}body${CLAIM}`.length)
    expect(render.draftToRendered(SRC.length)).toBe(0)
  })
})

describe('stripMarkers — offset maps', () => {
  it('draftToRendered is monotone with a plateau over each removed range', () => {
    const draft = `ab${SRC}cd`
    // draft: 'a'=0 'b'=1 marker(2..2+len) 'c','d' trailing
    const render = stripMarkers(draft)
    const end = 2 + SRC.length
    expect(render.text).toBe('abcd')
    expect(render.removed).toEqual([{ start: 2, end }])
    // Before the range: identity.
    expect(render.draftToRendered(0)).toBe(0)
    expect(render.draftToRendered(1)).toBe(1)
    expect(render.draftToRendered(2)).toBe(2)
    // Plateau: the whole removed range (endpoints included) collapses to one point.
    expect(render.draftToRendered(2 + 5)).toBe(2)
    expect(render.draftToRendered(end)).toBe(2)
    // After the range: shifted by the removed length.
    expect(render.draftToRendered(end + 1)).toBe(3)
    expect(render.draftToRendered(draft.length)).toBe(4)
  })

  it('renderedToDraft is right-biased at a removal seam', () => {
    const draft = `ab${SRC}cd`
    const end = 2 + SRC.length
    const render = stripMarkers(draft)
    expect(render.renderedToDraft(0)).toBe(0)
    expect(render.renderedToDraft(1)).toBe(1)
    // The seam maps to the first draft offset AFTER the removed range.
    expect(render.renderedToDraft(2)).toBe(end)
    expect(render.renderedToDraft(3)).toBe(end + 1)
    expect(render.renderedToDraft(4)).toBe(draft.length)
  })

  it('round-trips every offset that is not inside a removed range', () => {
    const draft = `intro${SRC} mid ${CLAIM} tail ${SRC}`
    const render = stripMarkers(draft)
    for (const range of render.removed) {
      expect(draft.slice(range.start, range.end)).toMatch(/^〔(?:src|claim):/)
    }
    // Every removed range [start, end) — start INCLUDED — collapses onto the
    // seam whose canonical (right-biased) preimage is `end`, so the loop-back
    // composition is the identity only outside those half-open ranges.
    for (let offset = 0; offset <= draft.length; offset++) {
      const inside = render.removed.some((range) => offset >= range.start && offset < range.end)
      if (inside) continue
      expect(render.renderedToDraft(render.draftToRendered(offset))).toBe(offset)
    }
    // And every rendered offset maps back through draft to itself.
    for (let offset = 0; offset <= render.text.length; offset++) {
      expect(render.draftToRendered(render.renderedToDraft(offset))).toBe(offset)
    }
  })
})

describe('intersectsRemoved — half-open [start,end) endpoint affinity (§4.5)', () => {
  const render = stripMarkers(`head${SRC}tail`)
  const [range] = render.removed

  it('rejects a span covering removed characters', () => {
    expect(intersectsRemoved({ start: range!.start, end: range!.end }, render.removed)).toBe(true)
    expect(intersectsRemoved({ start: range!.start + 1, end: range!.end - 1 }, render.removed)).toBe(true)
    expect(intersectsRemoved({ start: range!.start - 1, end: range!.start + 1 }, render.removed)).toBe(true)
    expect(intersectsRemoved({ start: range!.end - 1, end: range!.end + 1 }, render.removed)).toBe(true)
  })

  it('a span whose end equals a removed start is valid', () => {
    expect(intersectsRemoved({ start: 0, end: range!.start }, render.removed)).toBe(false)
  })

  it('a span whose start equals a removed end is valid', () => {
    expect(intersectsRemoved({ start: range!.end, end: range!.end + 3 }, render.removed)).toBe(false)
  })
})

describe('stripMarkers — surrogate pairs and CRLF', () => {
  it('maps in UTF-16 code units with astral characters on both sides', () => {
    const emoji = '\u{1F642}' // 🙂 = 2 code units
    const marker = `〔src:a${emoji}b〕`
    const draft = `${emoji}ab${marker}z${emoji}`
    const render = stripMarkers(draft)
    expect(render.text).toBe(`${emoji}abz${emoji}`)
    // z sits at draft offset 2+2+marker.length, rendered offset 4 (emoji counts 2 + 'ab' counts 2).
    expect(render.draftToRendered(2 + 2 + marker.length)).toBe(2 + 2)
    expect(render.renderedToDraft(2 + 2)).toBe(2 + 2 + marker.length)
    // Round-trip across every offset outside the removed range.
    for (let offset = 0; offset <= draft.length; offset++) {
      const inside = render.removed.some((range) => offset >= range.start && offset < range.end)
      if (!inside) expect(render.renderedToDraft(render.draftToRendered(offset))).toBe(offset)
    }
  })

  it('removes markers spanning CRLF and preserves surrounding offsets', () => {
    const draft = `a\r\n${SRC}\r\nb`
    const render = stripMarkers(draft)
    expect(render.text).toBe('a\r\n\r\nb')
    expect(render.removed).toEqual([{ start: 3, end: 3 + SRC.length }])
    expect(render.renderedToDraft(3)).toBe(3 + SRC.length)
    const spanning = stripMarkers(`x〔src:a\r\nb〕y`)
    expect(spanning.text).toBe('xy')
    expect(spanning.removed).toEqual([{ start: 1, end: 1 + '〔src:a\r\nb〕'.length }])
  })
})
