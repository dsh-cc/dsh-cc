import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { foldCounters } from '../src/fold-counters.ts'
import { projectKeyOf } from '../src/ledger.ts'

function home(): string {
  return mkdtempSync(join(tmpdir(), 'ccg-fold-'))
}

/** Writes the ledger file at the exact path the writer derives (same projectKey source). */
function writeLedger(dshHome: string, content: string): void {
  const dir = join(dshHome, 'compaction-cost-gate')
  mkdirSync(dir, { recursive: true })
  // The writer always newline-terminates each row (appendFile `${json}\n`).
  writeFileSync(join(dir, `${projectKeyOf(process.cwd())}.jsonl`), `${content}\n`, 'utf8')
}

const row = (kind: string): string => JSON.stringify({ ts: 't', sessionId: 's', kind, mode: 'on' })

describe('foldCounters (cost-gate ledger)', () => {
  it('full kind matrix: gate/compacted/skipped:*/compaction-unavailable counted', () => {
    const dshHome = home()
    writeLedger(dshHome, [row('gate'), row('gate'), row('compacted'), row('skipped:busy'), row('skipped:cancelled'), row('skipped:cooldown'), row('compaction-unavailable')].join('\n'))
    expect(foldCounters({ events: [], dshHome })).toEqual({
      'costgate.gate': 2,
      'costgate.compacted': 1,
      'costgate.skipped': 3,
      'costgate.unavailable': 1,
    })
  })

  it('missing ledger file → all-zero counters, not an error', () => {
    expect(foldCounters({ events: [], dshHome: home() })).toEqual({
      'costgate.gate': 0,
      'costgate.compacted': 0,
      'costgate.skipped': 0,
      'costgate.unavailable': 0,
    })
  })

  it('trailing partial line (live truncation) skipped silently', () => {
    const dshHome = home()
    // Live truncation: the partial row has NO terminating newline.
    const dir = join(dshHome, 'compaction-cost-gate')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${projectKeyOf(process.cwd())}.jsonl`), `${row('gate')}\n{"kind":"compac`, 'utf8')
    expect(foldCounters({ events: [], dshHome })).toEqual({
      'costgate.gate': 1,
      'costgate.compacted': 0,
      'costgate.skipped': 0,
      'costgate.unavailable': 0,
    })
  })

  it('malformed (non-tail) line throws with line number', () => {
    const dshHome = home()
    writeLedger(dshHome, `${row('gate')}\nnot-json\n${row('compacted')}`)
    expect(() => foldCounters({ events: [], dshHome })).toThrow(/line 2/)
  })
})
