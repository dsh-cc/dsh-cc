import { describe, expect, it } from 'vitest'
import { buildMarker, parseMarker } from '../src/marker.ts'
import { RETRIEVE_TOOL_DESCRIPTION, RETRIEVE_TOOL_NAME } from '../src/index.ts'

describe('marker contract (pinned)', () => {
  it('builds the exact documented literal', () => {
    expect(buildMarker(41230, 6180, 'a1b2c3d4e5f60708'))
      .toBe('[dsh-cc compressed 41230→6180 tokens. Original: ccr://a1b2c3d4e5f60708]')
  })

  it('round-trips build → parse', () => {
    const m = buildMarker(100, 20, '0123456789abcdef')
    expect(parseMarker(m)).toEqual({ tokensBefore: 100, tokensAfter: 20, hash: '0123456789abcdef' })
  })

  it('rejects non-markers and malformed hashes', () => {
    expect(parseMarker('not a marker')).toBeNull()
    expect(parseMarker('[dsh-cc compressed 1→0 tokens. Original: ccr://SHORT]')).toBeNull()
  })

  it(`the ${RETRIEVE_TOOL_NAME} description references the same ccr:// contract`, () => {
    // Pinned contract: the marker wording and the tool description share the
    // `ccr://<hash>` spelling and the `[dsh-cc compressed` lead-in.
    const marker = buildMarker(1, 0, 'a'.repeat(16))
    expect(marker.startsWith('[dsh-cc compressed ')).toBe(true)
    expect(marker).toContain('ccr://')
    expect(RETRIEVE_TOOL_DESCRIPTION).toContain('[dsh-cc compressed ')
    expect(RETRIEVE_TOOL_DESCRIPTION).toContain('ccr://')
    expect(RETRIEVE_TOOL_NAME).toBe('context_retrieve')
  })
})
