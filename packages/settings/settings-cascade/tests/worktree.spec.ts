import { describe, expect, it } from 'vitest'
import { WorktreeSchema, WORKTREE_DEFAULTS, worktreeSettings } from '../src/worktree.ts'

/** Parse a worktree section or throw. */
function parse(value: unknown): unknown {
  return (WorktreeSchema as unknown as (v: unknown) => unknown)(value)
}

describe('WorktreeSchema', () => {
  it('parses a full section and keeps unknown fields', () => {
    expect(parse({ baseRef: 'head', cleanupPeriodDays: 7, futureKey: 1 })).toEqual({
      baseRef: 'head',
      cleanupPeriodDays: 7,
      futureKey: 1,
    })
  })

  it('stays undefined when absent (absence-preserving union)', () => {
    expect(parse(undefined)).toBe(undefined)
  })

  it('keeps absent sub-keys absent — defaults apply at consumption time only', () => {
    expect(parse({})).toEqual({})
    expect(parse({ cleanupPeriodDays: 3 })).toEqual({ cleanupPeriodDays: 3 })
  })

  it('rejects a baseRef outside fresh|head', () => {
    expect(() => parse({ baseRef: 'main' })).toThrow()
  })

  it('rejects a non-number cleanupPeriodDays', () => {
    expect(() => parse({ cleanupPeriodDays: '30' })).toThrow()
  })
})

describe('worktreeSettings (consumption defaults)', () => {
  it('applies the documented defaults when the section is absent', () => {
    expect(worktreeSettings(undefined)).toEqual({ baseRef: 'fresh', cleanupPeriodDays: 30 })
    expect(WORKTREE_DEFAULTS).toEqual({ baseRef: 'fresh', cleanupPeriodDays: 30 })
  })

  it('layers a partial section over the defaults', () => {
    expect(worktreeSettings({ baseRef: 'head' } as never)).toEqual({ baseRef: 'head', cleanupPeriodDays: 30 })
    expect(worktreeSettings({ cleanupPeriodDays: 7 } as never)).toEqual({ baseRef: 'fresh', cleanupPeriodDays: 7 })
  })
})
