import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HISTORY_CAP,
  coldCutGlobalHistory,
  historyFilePath,
  loadHistory,
  saveHistory,
} from '@dsh-cc/tui/history.ts'

describe('composer history file', () => {
  it('round-trips save/load and returns oldest→newest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-history-'))
    const saved = saveHistory(['a', 'b', 'c'], dir)
    expect(saved).toEqual(['a', 'b', 'c'])
    expect(loadHistory(dir)).toEqual(['a', 'b', 'c'])
  })

  it('encodes multi-line prompts as JSON-lines (one entry per physical line)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-history-'))
    const multi = 'line one\nline two\nline three'
    saveHistory([multi], dir)
    // Round-trips the embedded newlines exactly.
    expect(loadHistory(dir)).toEqual([multi])
    // The raw file is one JSON string per line — a multi-line prompt must NOT
    // span multiple physical lines (that would corrupt line-based loading).
    const raw = readFileSync(historyFilePath(dir), 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(1)
  })

  it('suppresses consecutive duplicates but keeps non-consecutive repeats', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-history-'))
    saveHistory(['a', 'a', 'b', 'b', 'a'], dir)
    expect(loadHistory(dir)).toEqual(['a', 'b', 'a'])
  })

  it(`caps at ${HISTORY_CAP} entries, dropping the oldest`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-history-'))
    const entries = Array.from({ length: HISTORY_CAP + 100 }, (_, i) => `p${i}`)
    const saved = saveHistory(entries, dir)
    expect(saved).toHaveLength(HISTORY_CAP)
    // Newest survive; the oldest 100 are dropped.
    expect(saved[0]).toBe(`p${100}`)
    expect(saved[saved.length - 1]).toBe(`p${HISTORY_CAP + 99}`)
    expect(loadHistory(dir)).toEqual(saved)
  })

  it('returns [] for a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-history-'))
    expect(loadHistory(dir)).toEqual([])
  })

  it('returns [] for a corrupt file without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-history-'))
    writeFileSync(historyFilePath(dir), 'this is not json\n{broken\n')
    expect(loadHistory(dir)).toEqual([])
  })
})

describe('coldCutGlobalHistory', () => {
  it('sets aside both legacy global files as .global.bak', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-coldcut-'))
    writeFileSync(join(dir, 'history.txt'), '"old prompt"\n')
    writeFileSync(join(dir, 'bash-history.txt'), '"ls -la"\n')
    coldCutGlobalHistory(dir)
    expect(existsSync(join(dir, 'history.txt'))).toBe(false)
    expect(existsSync(join(dir, 'bash-history.txt'))).toBe(false)
    expect(readFileSync(join(dir, 'history.global.bak'), 'utf8')).toBe('"old prompt"\n')
    expect(readFileSync(join(dir, 'bash-history.global.bak'), 'utf8')).toBe('"ls -la"\n')
  })

  it('overwrites a previous backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-coldcut-'))
    writeFileSync(join(dir, 'history.txt'), '"newer"\n')
    writeFileSync(join(dir, 'history.global.bak'), '"stale backup"\n')
    coldCutGlobalHistory(dir)
    expect(readFileSync(join(dir, 'history.global.bak'), 'utf8')).toBe('"newer"\n')
  })

  it('is a no-op when the legacy files are absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-coldcut-'))
    expect(() => coldCutGlobalHistory(dir)).not.toThrow()
    expect(existsSync(join(dir, 'history.global.bak'))).toBe(false)
    expect(existsSync(join(dir, 'bash-history.global.bak'))).toBe(false)
  })
})
