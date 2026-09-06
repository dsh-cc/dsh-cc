import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HISTORY_CAP } from '@dsh-cc/tui/history.ts'
import {
  bashHistoryFilePath,
  loadBashHistory,
  saveBashHistory,
} from '@dsh-cc/tui/bash-history.ts'

/**
 * The bash-mode history file. Mirrors the composer history contract (same
 * dir resolution, same JSON-lines encoding, same cap constant) so shell
 * commands and composer prompts never dilute each other's recall stack.
 */
describe('bash history file', () => {
  it('stores commands under <data dir>/bash-history.txt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-bash-history-'))
    expect(bashHistoryFilePath(dir)).toBe(join(dir, 'bash-history.txt'))
  })

  it('round-trips save/load and returns oldest→newest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-bash-history-'))
    const saved = saveBashHistory(['echo a', 'echo b', 'echo c'], dir)
    expect(saved).toEqual(['echo a', 'echo b', 'echo c'])
    expect(loadBashHistory(dir)).toEqual(['echo a', 'echo b', 'echo c'])
  })

  it('encodes multi-line commands as JSON-lines (one entry per physical line)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-bash-history-'))
    const multi = 'echo one\necho two'
    saveBashHistory([multi], dir)
    expect(loadBashHistory(dir)).toEqual([multi])
    const raw = readFileSync(bashHistoryFilePath(dir), 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(1)
  })

  it('suppresses consecutive duplicates but keeps non-consecutive repeats', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-bash-history-'))
    saveBashHistory(['a', 'a', 'b', 'b', 'a'], dir)
    expect(loadBashHistory(dir)).toEqual(['a', 'b', 'a'])
  })

  it(`caps at ${HISTORY_CAP} entries, dropping the oldest`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-bash-history-'))
    const entries = Array.from({ length: HISTORY_CAP + 50 }, (_, i) => `cmd-${i}`)
    const saved = saveBashHistory(entries, dir)
    expect(saved).toHaveLength(HISTORY_CAP)
    expect(saved[0]).toBe('cmd-50')
    expect(saved[saved.length - 1]).toBe(`cmd-${HISTORY_CAP + 49}`)
    expect(loadBashHistory(dir)).toEqual(saved)
  })

  it('returns [] for a missing file and for a corrupt file, without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-bash-history-'))
    expect(loadBashHistory(dir)).toEqual([])
    writeFileSync(bashHistoryFilePath(dir), 'not json\n{broken\n')
    expect(loadBashHistory(dir)).toEqual([])
  })

  it('resolves the data dir from $DSH_HOME when no dir is injected', () => {
    const prev = process.env.DSH_HOME
    const home = mkdtempSync(join(tmpdir(), 'dsh-cc-bash-history-home-'))
    process.env.DSH_HOME = home
    try {
      expect(bashHistoryFilePath()).toBe(join(home, 'tui', 'bash-history.txt'))
      saveBashHistory(['echo env'])
      expect(loadBashHistory()).toEqual(['echo env'])
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
  })
})
