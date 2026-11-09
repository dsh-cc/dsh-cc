/**
 * Path-segment encoder contract: traversal safety, literal safe code units,
 * and `~XXXX` escaping of everything else. Expectations mirror the two
 * remaining per-package copies (config-snapshot, vwa-evidence) exactly.
 */

import { describe, expect, it } from 'vitest'
import { encodeSegment } from '../src/index.ts'

describe('encodeSegment', () => {
  it('throws on the empty string', () => {
    expect(() => encodeSegment('')).toThrow('cannot encode an empty path segment')
  })

  it('special-cases the dot segments to block traversal', () => {
    expect(encodeSegment('.')).toBe('~002E')
    expect(encodeSegment('..')).toBe('~002E~002E')
  })

  it('leaves safe code units [A-Za-z0-9._-] literal', () => {
    expect(encodeSegment('aZ09._-')).toBe('aZ09._-')
    expect(encodeSegment('a.b-c_D9')).toBe('a.b-c_D9')
    expect(encodeSegment('a..b')).toBe('a..b')
  })

  it('still escapes a bare tilde, which is the escape prefix', () => {
    expect(encodeSegment('~')).toBe('~007E')
    expect(encodeSegment('a~b')).toBe('a~007Eb')
  })

  it('escapes path separators and other unsafe ASCII', () => {
    // Dots are literal inside a longer segment; only a whole-segment dot is special-cased,
    // and the escaped separator keeps `../` from ever being a traversal component.
    expect(encodeSegment('../')).toBe('..~002F')
    expect(encodeSegment('/')).toBe('~002F')
    expect(encodeSegment('a b')).toBe('a~0020b')
  })

  it('escapes non-ASCII code units as uppercase ~XXXX', () => {
    expect(encodeSegment('é')).toBe('~00E9')
    expect(encodeSegment('中')).toBe('~4E2D')
  })

  it('encodes astral characters code unit by code unit (lone-surrogate safe)', () => {
    expect(encodeSegment('🙂')).toBe('~D83D~DE42')
  })
})
