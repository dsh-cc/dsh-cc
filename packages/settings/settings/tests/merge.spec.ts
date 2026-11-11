import { describe, expect, it } from 'vitest'
import {
  mergeValue,
  mergeSettingsSection,
  unionDenyPrecedence,
} from '../src/cascade/merge.ts'

describe('mergeValue', () => {
  it('deep-merges plain objects recursively', () => {
    const merged = mergeValue(
      { a: { b: 1, c: 2 }, d: 3 },
      { a: { c: 20 }, d: 30 },
    )
    expect(merged).toEqual({ a: { b: 1, c: 20 }, d: 30 })
  })

  it('lets a higher scalar replace a lower scalar wholesale', () => {
    expect(mergeValue('low', 'high')).toBe('high')
    expect(mergeValue(1, 2)).toBe(2)
    expect(mergeValue(null, { a: 1 })).toEqual({ a: 1 })
  })

  it('merges a higher object into a lower scalar by replacement', () => {
    expect(mergeValue({ a: 1 }, 'scalar')).toBe('scalar')
  })

  it('lets a higher non-permission array override the lower array wholesale', () => {
    expect(mergeValue(['a', 'b'], ['c'])).toEqual(['c'])
  })

  it('keeps the lower array when the higher layer does not carry the key', () => {
    const merged = mergeValue({ tags: ['a', 'b'] }, { other: 1 })
    expect(merged).toEqual({ tags: ['a', 'b'], other: 1 })
  })

  it('does not mutate either input', () => {
    const lower = { a: { b: 1 } }
    const higher = { a: { c: 2 } }
    mergeValue(lower, higher)
    expect(lower).toEqual({ a: { b: 1 } })
    expect(higher).toEqual({ a: { c: 2 } })
  })
})

describe('permission-array denial semantics', () => {
  it('unions allow and ask arrays across layers', () => {
    const merged = mergeValue<{ permissions: Record<string, unknown> }>(
      { permissions: { allow: ['a', 'b'] } },
      { permissions: { allow: ['b', 'c'] } },
    )
    expect(merged).toEqual({ permissions: { allow: ['a', 'b', 'c'] } })
  })

  it('unions deny arrays across layers', () => {
    const merged = mergeValue<{ permissions: Record<string, unknown> }>(
      { permissions: { deny: ['a'] } },
      { permissions: { deny: ['b', 'a'] } },
    )
    expect(merged).toEqual({ permissions: { deny: ['a', 'b'] } })
  })

  it('removes a denied rule from allow across layers (deny precedence)', () => {
    const merged = mergeValue<{ permissions: Record<string, unknown> }>(
      { permissions: { allow: ['Bash(a)', 'Bash(b)'], deny: [] } },
      { permissions: { allow: ['Bash(c)'], deny: ['Bash(a)'] } },
    )
    expect(merged.permissions).toEqual({
      allow: ['Bash(b)', 'Bash(c)'],
      deny: ['Bash(a)'],
    })
  })

  it('drops a lower allow rule when a higher deny names it', () => {
    const merged = mergeValue<{ permissions: Record<string, unknown> }>(
      { permissions: { allow: ['WebFetch'] } },
      { permissions: { deny: ['WebFetch'] } },
    )
    // An empty allow set is omitted; the deny wins.
    expect(merged.permissions.allow).toBeUndefined()
    expect(merged.permissions.deny).toEqual(['WebFetch'])
  })

  it('merges non-permission permission keys with ordinary rules (arrays override)', () => {
    const merged = mergeValue<{ permissions: Record<string, unknown> }>(
      { permissions: { additionalDirectories: ['/a'] } },
      { permissions: { additionalDirectories: ['/b'] } },
    )
    expect(merged).toEqual({ permissions: { additionalDirectories: ['/b'] } })
  })
})

describe('unionDenyPrecedence', () => {
  it('unions denies and excludes denied rules from the allowed set', () => {
    expect(unionDenyPrecedence(
      { allow: ['a', 'b'], deny: [] },
      { allow: ['b', 'c'], deny: ['a'] },
    )).toEqual({ allow: ['b', 'c'], deny: ['a'] })
  })
})

describe('mergeSettingsSection', () => {
  it('recursively merges a whole namespace section', () => {
    const merged = mergeSettingsSection(
      { theme: { color: 'dark' }, permissions: { allow: ['a'] } },
      { theme: { size: 'lg' }, permissions: { allow: ['b'] } },
    )
    expect(merged).toEqual({
      theme: { color: 'dark', size: 'lg' },
      permissions: { allow: ['a', 'b'] },
    })
  })
})
