import { describe, expect, it } from 'vitest'
import { formatEffortList, parseEffortChoice } from '@dsh-cc/tui/effort-catalog.ts'

const EFFORTS = ['minimal', 'low', 'medium', 'high'] as const

describe('parseEffortChoice', () => {
  it('treats default as a reserved keyword, even when a level is named default', () => {
    expect(parseEffortChoice('default', EFFORTS)).toEqual({ kind: 'default' })
    expect(parseEffortChoice('default', ['default', 'high'])).toEqual({ kind: 'default' })
  })

  it('matches an exact level from the model efforts', () => {
    expect(parseEffortChoice('high', EFFORTS)).toEqual({ kind: 'level', level: 'high' })
    expect(parseEffortChoice(' medium ', EFFORTS)).toEqual({ kind: 'level', level: 'medium' })
  })

  it('rejects unknown or empty input', () => {
    expect(parseEffortChoice('ultra', EFFORTS)).toBeUndefined()
    expect(parseEffortChoice('', EFFORTS)).toBeUndefined()
    expect(parseEffortChoice('   ', EFFORTS)).toBeUndefined()
  })

  it('only accepts default when the efforts list is empty', () => {
    expect(parseEffortChoice('high', [])).toBeUndefined()
    expect(parseEffortChoice('default', [])).toEqual({ kind: 'default' })
  })
})

describe('formatEffortList', () => {
  it('lists levels plus a trailing default entry, starring the current effort', () => {
    expect(formatEffortList(EFFORTS, 'medium')).toBe([
      '  minimal',
      '  low',
      '* medium',
      '  high',
      '  default (provider)',
    ].join('\n'))
  })

  it('stars the default entry when no effort is set', () => {
    const text = formatEffortList(EFFORTS, undefined)
    expect(text.split('\n').at(-1)).toBe('* default (provider)')
    expect(text).not.toContain('* low')
    expect(text).toContain('  high')
  })

  it('always offers default, even with no model efforts', () => {
    expect(formatEffortList([], undefined)).toBe('* default (provider)')
    expect(formatEffortList([], 'low')).toBe('  default (provider)')
  })
})
