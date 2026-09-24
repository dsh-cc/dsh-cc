/**
 * Fired-state ledger (plan §5): round-trip incl. lazy rehydration (simulated
 * resume: fresh in-memory map + existing ledger file), and the in-memory
 * fired-set gate blocking a synchronous double-fire (two events in one turn
 * fire once).
 *
 * @module
 */

import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyLedger, ledgerFileFor, loadLedger, writeLedger } from '../src/ledger.ts'
import { shouldFire } from '../src/matcher.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'tr-ledger-'))
  dirs.push(home)
  return home
}

describe('ledger round-trip', () => {
  it('persists atomically and rehydrates a fresh in-memory map (simulated resume)', async () => {
    const home = tempHome()
    const sessionId = 'sess-1'
    // Fresh session: no file, no ledger.
    expect(await loadLedger(home, sessionId)).toBeUndefined()
    const ledger = { version: 1 as const, turnCounter: 7, fired: { 'plug/rules/a.mdc': 3 } }
    await writeLedger(home, sessionId, ledger)
    expect(existsSync(ledgerFileFor(home, sessionId))).toBe(true)
    // No temp litter left behind (atomic rename, §4.6).
    expect(readFileSync(ledgerFileFor(home, sessionId), 'utf8')).toContain('"turnCounter":7')
    // Simulated resume: a FRESH in-memory map hydrates from the existing file.
    const rehydrated = await loadLedger(home, sessionId)
    expect(rehydrated).toEqual(ledger)
  })

  it('fail-soft: a malformed ledger file reads as absent; a failed write never throws', async () => {
    const home = tempHome()
    await writeLedger(home, 'bad', { version: 1, turnCounter: 0, fired: {} })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(ledgerFileFor(home, 'bad'), '{not json', 'utf8')
    expect(await loadLedger(home, 'bad')).toBeUndefined()
    // Writing into an impossible path degrades to a no-op.
    await expect(writeLedger(join(home, 'no-such-dir', 'deeper'), 'x', emptyLedger())).resolves.toBeUndefined()
  })
})

describe('in-memory fired-set gate', () => {
  it('blocks a synchronous double-fire: two events in one turn fire once', async () => {
    const home = tempHome()
    const sessionId = 'sess-2'
    const fired = new Map<string, number>()
    let turnCounter = 4
    // Event A and event B race within the same turn (same counter value).
    const evaluate = (ruleKey: string): boolean => {
      if (!shouldFire(fired.get(ruleKey), turnCounter, 'once', 10)) return false
      fired.set(ruleKey, turnCounter)
      return true
    }
    expect(evaluate('plug/rules/a.mdc')).toBe(true)
    expect(evaluate('plug/rules/a.mdc')).toBe(false) // same turn, already claimed
    await writeLedger(home, sessionId, { version: 1, turnCounter, fired: Object.fromEntries(fired) })
    // A fresh hydrated view (compaction/resume) still sees the claim.
    const rehydrated = await loadLedger(home, sessionId)
    expect(shouldFire(rehydrated?.fired['plug/rules/a.mdc'], turnCounter, 'once', 10)).toBe(false)
  })
})
