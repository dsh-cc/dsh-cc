import { describe, expect, it } from 'vitest'
import {
  MAX_ENTRYPOINT_LINES,
  truncateEntrypointContent,
} from '../src/truncate.ts'
import { validateMemoryWrites } from '../src/writeback.ts'

describe('truncateEntrypointContent', () => {
  it('returns content unchanged when within both caps', () => {
    const raw = 'line one\nline two\n'
    const result = truncateEntrypointContent(raw)
    expect(result.content).toBe('line one\nline two')
    expect(result.lineCount).toBe(2)
    expect(result.byteCount).toBe(17)
    expect(result.wasLineTruncated).toBe(false)
    expect(result.wasByteTruncated).toBe(false)
  })

  it('line-truncates at the line cap and reports a warning', () => {
    const raw = Array.from({ length: MAX_ENTRYPOINT_LINES + 3 }, (_, i) => `line ${i}`).join('\n')
    const result = truncateEntrypointContent(raw)
    expect(result.wasLineTruncated).toBe(true)
    expect(result.wasByteTruncated).toBe(false)
    const keptLines = result.content.split('\n')
    // body cap (MAX_ENTRYPOINT_LINES - 2) + blank + warning line
    expect(keptLines).toHaveLength(MAX_ENTRYPOINT_LINES)
    expect(result.content).toContain('WARNING: MEMORY.md is 203 lines')
  })

  it('byte-truncates oversized content without cutting mid-line', () => {
    // 200 short lines whose total exceeds the byte cap but not the line cap:
    // the byte path must drop whole trailing lines rather than split one.
    const lines = Array.from({ length: MAX_ENTRYPOINT_LINES }, (_, i) => `line ${i} `.repeat(20))
    const raw = lines.join('\n')
    const result = truncateEntrypointContent(raw)
    expect(result.wasLineTruncated).toBe(false)
    expect(result.wasByteTruncated).toBe(true)
    expect(result.content).toContain('WARNING: MEMORY.md is')
    // Every preserved body line is a whole original line (all start with "line ").
    const body = result.content.split('\n').slice(0, -1).filter(line => line.length > 0)
    expect(body.every(line => line.startsWith('line '))).toBe(true)
  })

  it('reports both caps when both fire', () => {
    const lines = Array.from({ length: MAX_ENTRYPOINT_LINES + 10 }, () => 'x'.repeat(1000))
    const raw = lines.join('\n')
    const result = truncateEntrypointContent(raw)
    expect(result.wasLineTruncated).toBe(true)
    expect(result.wasByteTruncated).toBe(true)
    expect(result.content).toContain('WARNING: MEMORY.md is')
  })

  it('line-truncates first, then byte-truncates the retained lines', () => {
    // Long enough that even the line-capped prefix exceeds the byte cap.
    const lines = Array.from({ length: MAX_ENTRYPOINT_LINES + 5 }, () => 'x'.repeat(300))
    const raw = lines.join('\n')
    const result = truncateEntrypointContent(raw)
    expect(result.wasLineTruncated).toBe(true)
    expect(result.wasByteTruncated).toBe(true)
    expect(result.content).toContain('WARNING: MEMORY.md is')
    // Retained body ends with an untouched "xxx" line, never a split one.
    const body = result.content.split('\n').slice(0, -1).filter(line => line.length > 0)
    expect(body.every(line => /^x+$/.test(line))).toBe(true)
  })

  it('emits the warning on its own trailing line', () => {
    const raw = Array.from({ length: MAX_ENTRYPOINT_LINES + 1 }, () => 'abc').join('\n')
    const result = truncateEntrypointContent(raw)
    expect(result.content.split('\n').at(-1)?.startsWith('> WARNING:')).toBe(true)
  })

  it('measures byteCount in UTF-8 bytes, not UTF-16 code units (CJK)', () => {
    // 100 CJK chars = 100 code units but 300 UTF-8 bytes.
    const small = truncateEntrypointContent('你'.repeat(100))
    expect(small.byteCount).toBe(300)
    expect(small.wasByteTruncated).toBe(false)
    // 9 000 CJK chars = 9 000 code units but 27 000 bytes → byte cap fires.
    const big = truncateEntrypointContent('你'.repeat(9_000))
    expect(big.wasByteTruncated).toBe(true)
    expect(big.wasLineTruncated).toBe(false)
  })

  it('byte-cuts on a whole-line boundary (CJK-safe)', () => {
    const lines = Array.from({ length: MAX_ENTRYPOINT_LINES }, (_, i) => `日${i} `.repeat(40))
    const result = truncateEntrypointContent(lines.join('\n'))
    expect(result.wasLineTruncated).toBe(false)
    expect(result.wasByteTruncated).toBe(true)
    // A mid-character cut would corrupt a line; every kept body line is whole.
    const body = result.content.split('\n').filter(line => line.length > 0 && !line.startsWith('> WARNING'))
    expect(body.length).toBeGreaterThan(0)
    expect(body.every(line => /^日\d+( 日\d+)* $/.test(line))).toBe(true)
  })

  it('truncation output always satisfies the write-side gate (banner headroom)', () => {
    const raw = Array.from(
      { length: 500 },
      (_, i) => `- [m${i}](m${i}.md) — 这是一条中文记忆条目，用来撑爆字节上限`,
    ).join('\n')
    const result = truncateEntrypointContent(raw)
    expect(result.wasLineTruncated).toBe(true)
    expect(result.wasByteTruncated).toBe(true)
    expect(() => validateMemoryWrites({
      writes: [{ path: 'MEMORY.md', content: result.content }],
    })).not.toThrow()
  })
})
