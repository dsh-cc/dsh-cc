import { describe, expect, it } from 'vitest'
import { DEFAULT_DIFF_LINE_CAP, renderDiffLines } from '@dsh-cc/tui/components/diff-card.ts'
import { computeHunks, DIFF_LCS_LINE_CAP } from '@dsh-cc/tui/components/diff-hunks.ts'
import type { FileDiff } from '@dsh-cc/tui/tool-card.ts'

/** Strip SGR sequences for readability in assertions that check structure. */
function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

const RED = '\x1b[31m'
const GREEN = '\x1b[32m'

describe('renderDiffLines', () => {
  it('returns [] for an empty diffs array', () => {
    expect(renderDiffLines([])).toEqual([])
  })

  it('tags a new file with (new file)', () => {
    const diffs: FileDiff[] = [{ path: 'foo.ts', oldText: null, newText: 'hello\n' }]
    const lines = renderDiffLines(diffs).map(strip)
    expect(lines[0]).toBe('  foo.ts (new file)')
    expect(lines.some(l => l.includes('+ hello'))).toBe(true)
  })

  it('tags a deleted file with (deleted)', () => {
    const diffs: FileDiff[] = [{ path: 'bar.ts', oldText: 'content\n', newText: '' }]
    const lines = renderDiffLines(diffs).map(strip)
    expect(lines[0]).toBe('  bar.ts (deleted)')
    expect(lines.some(l => l.includes('- content'))).toBe(true)
  })

  it('omits a tag for an in-place edit', () => {
    const diffs: FileDiff[] = [{ path: 'baz.ts', oldText: 'a\n', newText: 'b\n' }]
    const lines = renderDiffLines(diffs).map(strip)
    expect(lines[0]).toBe('  baz.ts')
  })

  it('emits red removals and green additions with SGR codes', () => {
    const diffs: FileDiff[] = [{ path: 'f.ts', oldText: 'old\n', newText: 'new\n' }]
    const lines = renderDiffLines(diffs)
    const removed = lines.find(l => strip(l).includes('- old'))
    const added = lines.find(l => strip(l).includes('+ new'))
    expect(removed).toBeDefined()
    expect(added).toBeDefined()
    expect(removed!).toContain(RED)
    expect(added!).toContain(GREEN)
  })

  it('collapses common prefix and suffix, showing only the changed middle + context', () => {
    // 20 lines: lines 1-8 and 13-20 are unchanged; line 9 changes.
    const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
    const newLines = oldLines.slice()
    newLines[8] = 'CHANGED'
    const diffs: FileDiff[] = [{
      path: 'big.ts',
      oldText: oldLines.join('\n') + '\n',
      newText: newLines.join('\n') + '\n',
    }]
    const lines = renderDiffLines(diffs).map(strip)
    // Header + context prefix (≤2) + 1 removal + 1 addition + context suffix (≤2)
    // = at most 7 lines, NOT 20+.
    expect(lines.length).toBeLessThanOrEqual(8)
    expect(lines[0]).toBe('  big.ts')
    // The changed line must appear.
    expect(lines.some(l => l.includes('- line 9'))).toBe(true)
    expect(lines.some(l => l.includes('+ CHANGED'))).toBe(true)
    // Unchanged middle lines far from the edit must NOT appear.
    expect(lines.some(l => l.includes('line 5'))).toBe(false)
    expect(lines.some(l => l.includes('line 15'))).toBe(false)
    // Context lines near the edit SHOULD appear (dimmed, leading space).
    expect(lines.some(l => l.startsWith('    line 7'))).toBe(true)
    expect(lines.some(l => l.startsWith('    line 11'))).toBe(true)
  })

  it('emits a single dim (no changes) line when old === new', () => {
    const diffs: FileDiff[] = [{ path: 'same.ts', oldText: 'a\nb\n', newText: 'a\nb\n' }]
    const lines = renderDiffLines(diffs).map(strip)
    expect(lines).toEqual(['  same.ts', '    (no changes)'])
  })

  it('caps total lines with a trailer when the diff is huge', () => {
    // 200 lines all different → 200 removals + 200 additions, well over the cap.
    const oldText = Array.from({ length: 200 }, (_, i) => `old ${i + 1}`).join('\n') + '\n'
    const newText = Array.from({ length: 200 }, (_, i) => `new ${i + 1}`).join('\n') + '\n'
    const diffs: FileDiff[] = [{ path: 'huge.ts', oldText, newText }]
    const lines = renderDiffLines(diffs)
    expect(lines.length).toBeLessThanOrEqual(62) // cap + header + trailer
    const last = strip(lines[lines.length - 1]!)
    expect(last).toMatch(/… \(\d+ more lines\)/)
  })

  it('handles multiple files in one diff array', () => {
    const diffs: FileDiff[] = [
      { path: 'a.ts', oldText: null, newText: 'x\n' },
      { path: 'b.ts', oldText: 'y\n', newText: 'z\n' },
    ]
    const lines = renderDiffLines(diffs).map(strip)
    expect(lines.some(l => l === '  a.ts (new file)')).toBe(true)
    expect(lines.some(l => l === '  b.ts')).toBe(true)
    expect(lines.some(l => l.includes('+ x'))).toBe(true)
    expect(lines.some(l => l.includes('- y'))).toBe(true)
    expect(lines.some(l => l.includes('+ z'))).toBe(true)
  })

  it('normalizes trailing newlines consistently', () => {
    // newText with no trailing newline should still split cleanly.
    const diffs: FileDiff[] = [{ path: 'f.ts', oldText: 'a\nb', newText: 'a\nC' }]
    const lines = renderDiffLines(diffs).map(strip)
    expect(lines.some(l => l.includes('- b'))).toBe(true)
    expect(lines.some(l => l.includes('+ C'))).toBe(true)
    // 'a' is common prefix, should not appear as a +/− line.
    expect(lines.some(l => l.startsWith('+ a'))).toBe(false)
    expect(lines.some(l => l.startsWith('- a'))).toBe(false)
  })

  it('gutters removals with the old-side number and additions with the new-side number', () => {
    const diffs: FileDiff[] = [{ path: 'f.ts', oldText: 'a\nb\nc\n', newText: 'a\nB\nc\n' }]
    expect(renderDiffLines(diffs).map(strip)).toEqual([
      '  f.ts',
      '    a',
      '  2 - b',
      '  2 + B',
      '    c',
    ])
  })

  it('numbers multi-line insertions sequentially on the new side', () => {
    const diffs: FileDiff[] = [{ path: 'f.ts', oldText: 'a\nb\nc\n', newText: 'a\nX\nY\nc\n' }]
    const lines = renderDiffLines(diffs).map(strip)
    expect(lines).toContain('  2 - b')
    expect(lines).toContain('  2 + X')
    expect(lines).toContain('  3 + Y')
  })

  it('renders several hunks separated by dim unchanged-line markers with exact counts', () => {
    const oldLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
    const newLines = oldLines.slice()
    newLines[2] = 'EDIT3'
    newLines[27] = 'EDIT28'
    const diffs: FileDiff[] = [{
      path: 'big.ts',
      oldText: oldLines.join('\n') + '\n',
      newText: newLines.join('\n') + '\n',
    }]
    const lines = renderDiffLines(diffs).map(strip)
    // Lines 4-27 (24 lines) collapse to exactly one marker.
    expect(lines.filter(l => l.includes('unchanged lines'))).toEqual([
      '    … 24 unchanged lines …',
    ])
    // Collapsed gap content must not leak into the output.
    expect(lines.some(l => l.includes('line 15'))).toBe(false)
    expect(lines.some(l => l.includes('- line 3'))).toBe(true)
    expect(lines.some(l => l.includes('- line 28'))).toBe(true)
  })

  it('clusters adjacent hunks: small unchanged runs render as dim context, without a marker', () => {
    const oldLines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`)
    const newLines = oldLines.slice()
    newLines[4] = 'EDIT5'
    newLines[7] = 'EDIT8'
    const diffs: FileDiff[] = [{
      path: 'f.ts',
      oldText: oldLines.join('\n') + '\n',
      newText: newLines.join('\n') + '\n',
    }]
    const lines = renderDiffLines(diffs).map(strip)
    // The 2-line gap between the edits (lines 6-7) is shown as plain context,
    // so the two changes read as one cluster — no collapse marker anywhere.
    expect(lines.some(l => l.includes('unchanged lines'))).toBe(false)
    expect(lines).toContain('    line 6')
    expect(lines).toContain('    line 7')
    expect(lines.some(l => l.includes('- line 5'))).toBe(true)
    expect(lines.some(l => l.includes('- line 8'))).toBe(true)
  })

  it('renders the over-cap fallback with correct gutters and no marker', () => {
    const oldLines = Array.from({ length: DIFF_LCS_LINE_CAP + 10 }, (_, i) => `L${i + 1}`)
    const newLines = oldLines.slice()
    newLines[1999] = 'CHANGED'
    const diffs: FileDiff[] = [{
      path: 'huge.ts',
      oldText: oldLines.join('\n') + '\n',
      newText: newLines.join('\n') + '\n',
    }]
    const lines = renderDiffLines(diffs).map(strip)
    expect(lines.length).toBeLessThanOrEqual(DEFAULT_DIFF_LINE_CAP + 2)
    expect(lines).toContain('  2000 - L2000')
    expect(lines).toContain('  2000 + CHANGED')
    // A single hunk has no interior gap to collapse.
    expect(lines.some(l => l.includes('unchanged lines'))).toBe(false)
  })

  it('stops at a hunk boundary when the line cap is hit', () => {
    // 20 single-line changes spaced 31 lines apart: the full render is 63
    // lines, so the default cap cuts inside the hunk sequence.
    const oldLines: string[] = []
    const newLines: string[] = []
    for (let i = 0; i < 20; i++) {
      for (let k = 0; k < 31; k++) {
        const n = i * 31 + k + 1
        oldLines.push(`line ${n}`)
        newLines.push(k === 1 ? `EDIT ${n}` : `line ${n}`)
      }
    }
    const diffs: FileDiff[] = [{
      path: 'many.ts',
      oldText: oldLines.join('\n') + '\n',
      newText: newLines.join('\n') + '\n',
    }]
    const lines = renderDiffLines(diffs).map(strip)
    const removals = lines.filter(l => /^ {2}\d+ - /.test(l))
    const additions = lines.filter(l => /^ {2}\d+ \+ /.test(l))
    // No half-emitted hunk: every removal that made it under the cap still
    // has its paired addition.
    expect(removals.length).toBe(additions.length)
    expect(removals.length).toBeGreaterThanOrEqual(15)
    expect(lines[lines.length - 1]).toMatch(/… \(\d+ more lines\)/)
  })

  it('streams an oversized new-file body to the cap and appends the trailer', () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const diffs: FileDiff[] = [{ path: 'new.ts', oldText: null, newText: text }]
    const lines = renderDiffLines(diffs).map(strip)
    expect(lines.length).toBeLessThanOrEqual(DEFAULT_DIFF_LINE_CAP + 2)
    expect(lines.some(l => l.includes('+ line 1'))).toBe(true)
    // Streaming, not dropping: the bulk of the body must still be emitted.
    expect(lines.filter(l => l.includes('+ line ')).length).toBeGreaterThanOrEqual(50)
    expect(lines[lines.length - 1]).toMatch(/… \(\d+ more lines\)/)
  })
})

describe('computeHunks', () => {
  it('returns no hunks for identical texts', () => {
    expect(computeHunks('a\nb\n', 'a\nb\n')).toEqual([])
    expect(computeHunks('', '')).toEqual([])
  })

  it('pins DIFF_LCS_LINE_CAP at 4000', () => {
    expect(DIFF_LCS_LINE_CAP).toBe(4000)
  })

  it('yields one hunk per contiguous change region', () => {
    const oldLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
    const newLines = oldLines.slice()
    newLines[1] = 'A2'
    newLines[7] = 'A8'
    const oldText = oldLines.join('\n') + '\n'
    const newText = newLines.join('\n') + '\n'
    expect(computeHunks(oldText, newText)).toEqual([
      { oldStart: 2, newStart: 2, removed: ['line 2'], added: ['A2'] },
      { oldStart: 8, newStart: 8, removed: ['line 8'], added: ['A8'] },
    ])
  })

  it('numbers hunks correctly when deletions and insertions interleave', () => {
    // old: a b c d e → new: a X Y c d Z e
    const hunks = computeHunks('a\nb\nc\nd\ne\n', 'a\nX\nY\nc\nd\nZ\ne\n')
    expect(hunks).toEqual([
      { oldStart: 2, newStart: 2, removed: ['b'], added: ['X', 'Y'] },
      { oldStart: 5, newStart: 6, removed: [], added: ['Z'] },
    ])
  })

  it('falls back to a single prefix/suffix hunk when either side exceeds DIFF_LCS_LINE_CAP', () => {
    const oldLines = Array.from({ length: DIFF_LCS_LINE_CAP + 10 }, (_, i) => `L${i + 1}`)
    const newLines = oldLines.slice()
    newLines[1999] = 'CHANGED'
    const hunks = computeHunks(oldLines.join('\n') + '\n', newLines.join('\n') + '\n')
    expect(hunks).toEqual([
      { oldStart: 2000, newStart: 2000, removed: ['L2000'], added: ['CHANGED'] },
    ])
  })

  it('collapses distant changes into one hunk in the over-cap fallback', () => {
    const oldLines = Array.from({ length: DIFF_LCS_LINE_CAP + 10 }, (_, i) => `L${i + 1}`)
    const newLines = oldLines.slice()
    newLines[1] = 'A2'
    newLines[3999] = 'A4000'
    const hunks = computeHunks(oldLines.join('\n') + '\n', newLines.join('\n') + '\n')
    expect(hunks.length).toBe(1)
    expect(hunks[0]).toMatchObject({ oldStart: 2, newStart: 2 })
  })
})
