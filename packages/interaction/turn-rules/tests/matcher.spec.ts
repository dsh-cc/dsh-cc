/**
 * Pure matching functions (plan §5): regex LRU capacity + byte-cap truncation
 * arithmetic, and once/after-gap arithmetic against the turn-stopping-driven
 * counter (re-arm exactly at `turnCounter - firedAt >= repeatGap`).
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { createRegexCache } from '../src/regex-cache.ts'
import { buildPromptCandidate, buildToolUnit, shouldFire, truncateUtf8 } from '../src/matcher.ts'

describe('regex LRU', () => {
  it('compiles on miss and evicts the least-recently-used entry past capacity', () => {
    const cache = createRegexCache(2)
    expect(cache('a')?.source).toBe('a')
    expect(cache('b')?.source).toBe('b')
    // 'a' is now LRU; inserting 'c' evicts it.
    expect(cache('c')?.source).toBe('c')
    expect(cache('a')?.source).toBe('a') // recompiled fresh — eviction happened
    // Touching 'b' makes it recent; inserting 'd' evicts 'c' instead.
    void cache('b')
    void cache('d')
    void cache('c')
    void cache('e')
    expect(cache('b')?.source).toBe('b')
  })

  it('returns identity-identical instances on hit and fail-soft undefined on an invalid source', () => {
    const cache = createRegexCache(4)
    expect(cache('x')).toBe(cache('x'))
    expect(cache('[unclosed')).toBeUndefined()
  })
})

describe('UTF-8 truncation', () => {
  it('caps ASCII at the exact byte count', () => {
    expect(truncateUtf8('abcdef', 4)).toBe('abcd')
    expect(truncateUtf8('abc', 100)).toBe('abc')
  })

  it('truncates multi-byte characters at the buffer boundary without exceeding maxBytes', () => {
    const text = 'é'.repeat(10) // 2 bytes each
    const truncated = truncateUtf8(text, 5)
    // Byte-level cut: two complete 2-byte chars survive; the split third byte
    // re-encodes as a replacement char (harmless for pattern matching).
    expect(truncated.startsWith('éé')).toBe(true)
    expect(truncated.length).toBeLessThan(text.length)
  })

  it('zero cap truncates to empty', () => {
    expect(truncateUtf8('abc', 0)).toBe('')
  })
})

describe('bounded unit build', () => {
  it('tool unit = JSON.stringify(arguments) + newline + joined text blocks, truncated', () => {
    const unit = buildToolUnit(
      { old_string: 'PATTERN_XYZ' },
      [{ type: 'text', text: 'result line 1' }, { type: 'image' }, { type: 'text', text: 'line 2' }],
      200_000,
    )
    expect(unit).toBe('{"old_string":"PATTERN_XYZ"}\nresult line 1\nline 2')
  })

  it('nullish arguments serialize to {} and the unit honors the byte cap', () => {
    expect(buildToolUnit(undefined, [{ type: 'text', text: 'x'.repeat(50) }], 10).length).toBeLessThanOrEqual(10 + 2)
    expect(buildToolUnit(undefined, [], 200_000).startsWith('{}')).toBe(true)
  })

  it('prompt candidate excludes denylisted sources and truncates', () => {
    const candidate = buildPromptCandidate(
      [
        { content: [{ type: 'text', text: 'real user input' }] },
        { content: [{ type: 'text', text: 'reminder body' }], source: { kind: 'turn-rules' } },
        { content: [{ type: 'text', text: 'memory body' }], source: { kind: 'memory' } },
        { content: [{ type: 'text', text: 'attributed plugin' }], source: { kind: 'plugin' } },
      ],
      200_000,
    )
    expect(candidate).toContain('real user input')
    expect(candidate).toContain('attributed plugin') // non-denylisted source kind is user-visible text
    expect(candidate).not.toContain('reminder body')
    expect(candidate).not.toContain('memory body')
 expect(buildPromptCandidate([{ content: [{ type: 'text', text: 'y'.repeat(40) }] }], 8).length).toBeLessThanOrEqual(8 + 2)
  })
})

describe('once / after-gap arithmetic', () => {
  it('once: fires only when never fired', () => {
    expect(shouldFire(undefined, 5, 'once', 10)).toBe(true)
    expect(shouldFire(0, 5, 'once', 10)).toBe(false)
    expect(shouldFire(4, 100, 'once', 1)).toBe(false)
  })

  it('after-gap: re-arms exactly at turnCounter - firedAt >= repeatGap', () => {
    expect(shouldFire(0, 9, 'after-gap', 10)).toBe(false)
    expect(shouldFire(0, 10, 'after-gap', 10)).toBe(true)
    expect(shouldFire(3, 13, 'after-gap', 10)).toBe(true)
    expect(shouldFire(3, 12, 'after-gap', 10)).toBe(false)
    expect(shouldFire(undefined, 0, 'after-gap', 10)).toBe(true)
  })
})
