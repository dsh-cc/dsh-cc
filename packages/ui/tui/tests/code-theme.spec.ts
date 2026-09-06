import { describe, expect, it } from 'vitest'
import { highlightCodeAnsi } from '@dsh-cc/tui/components/code-theme.ts'

/** Strip every SGR sequence so assertions can compare against raw source. */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

describe('highlightCodeAnsi', () => {
  it('styles keywords and number literals with SGR and preserves line count', () => {
    const lines = highlightCodeAnsi('const x = 1', 'typescript')
    expect(lines.length).toBe(1)
    // `const` carries the keyword SGR (yellow = code 33).
    expect(lines[0]).toContain('\x1b[33mconst\x1b[0m')
    // `1` carries the number SGR (cyan = code 36).
    expect(lines[0]).toContain('\x1b[36m1\x1b[0m')
    // Stripping ANSI reproduces the exact source line.
    expect(stripAnsi(lines[0]!)).toBe('const x = 1')
  })

  it('does not bleed ANSI across lines', () => {
    const code = 'const a = 1\nconst b = 2'
    const lines = highlightCodeAnsi(code, 'typescript')
    expect(lines.length).toBe(2)
    // Stripping ANSI from each line reproduces the exact source line.
    expect(stripAnsi(lines[0]!)).toBe('const a = 1')
    expect(stripAnsi(lines[1]!)).toBe('const b = 2')
    // Every SGR opener a line opens is closed before the line end.
    for (const ln of lines) {
      const opens = (ln.match(/\x1b\[[1-9]\d*m/g) ?? []).length
      const resets = (ln.match(/\x1b\[0m/g) ?? []).length
      expect(opens).toBe(resets)
    }
  })

  it('does not bleed ANSI across a multi-line comment span', () => {
    const code = '/* multi\nline */ x'
    const lines = highlightCodeAnsi(code, 'javascript')
    expect(lines.length).toBe(2)
    expect(stripAnsi(lines[0]!)).toBe('/* multi')
    expect(stripAnsi(lines[1]!)).toBe('line */ x')
    for (const ln of lines) {
      const opens = (ln.match(/\x1b\[[1-9]\d*m/g) ?? []).length
      const resets = (ln.match(/\x1b\[0m/g) ?? []).length
      expect(opens).toBe(resets)
    }
  })

  it('falls back to plain text for an unknown language', () => {
    expect(highlightCodeAnsi('const x = 1', 'frobnicate')).toEqual(['const x = 1'])
    expect(highlightCodeAnsi('const x = 1\nx = 2', 'frobnicate')).toEqual([
      'const x = 1',
      'x = 2',
    ])
  })

  it('falls back to plain text when the language is undefined', () => {
    expect(highlightCodeAnsi('const x = 1', undefined)).toEqual(['const x = 1'])
  })

  it('returns a single empty line for empty code', () => {
    expect(highlightCodeAnsi('', 'typescript')).toEqual([''])
    expect(highlightCodeAnsi('', undefined)).toEqual([''])
  })
})
