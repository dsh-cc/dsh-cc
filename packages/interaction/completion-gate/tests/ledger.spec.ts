/**
 * Ledger + settings (plan docs/plans/2026-10-09-runtime-verified-completion.md
 * §3.2/§3.5): tempdir append (no head in rows, parent dirs created), 100-file
 * sweep, settings defaults + hot reads.
 *
 * @module
 */

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendLedgerRow, ledgerFileFor, ledgerRowOf, sweepReceipts, RETENTION_FILES } from '../src/ledger.ts'
import { DEFAULT_GATE_SETTINGS, readUserSettings, readUserSettingsSync } from '../src/settings.ts'
import type { Receipt } from '../src/events.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cg-ledger-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

const receipt: Receipt = {
  v: 1,
  ts: 1712345678901,
  sessionId: 's1',
  callId: 'call_1',
  tool: 'bash',
  argsDigest: 'a'.repeat(16),
  outcome: 'ok',
  errorCode: null,
  contentHash: 'b'.repeat(16),
  textBytes: 8,
  head: 'pnpm test',
}

describe('ledger (§3.2)', () => {
  it('rows NEVER contain head', () => {
    expect(ledgerRowOf(receipt)).not.toHaveProperty('head')
    expect(ledgerRowOf(receipt)).toMatchObject({ v: 1, tool: 'bash', contentHash: 'b'.repeat(16) })
  })

  it('append creates parent dirs and writes valid JSONL', async () => {
    const base = tempDir()
    const file = ledgerFileFor(join(base, 'nested', 'receipts'), 's1')
    let logged = ''
    appendLedgerRow(file, ledgerRowOf(receipt), msg => { logged = msg })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(logged).toBe('')
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const row = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(row).not.toHaveProperty('head')
    expect(row.sessionId).toBe('s1')
  })

  it('sweep keeps the newest 100 files', async () => {
    const dir = join(tempDir(), 'receipts')
    mkdirSync(dir, { recursive: true })
    const total = RETENTION_FILES + 5
    for (let i = 0; i < total; i++) {
      const file = join(dir, `s${i}.jsonl`)
      writeFileSync(file, '{}\n', 'utf8')
      utimesSync(file, new Date(1_000_000 + i), new Date(1_000_000 + i))
    }
    const kept = await sweepReceipts(dir)
    expect(kept).toHaveLength(RETENTION_FILES)
    // The five oldest (lowest mtime) are gone.
    for (let i = 0; i < 5; i++) expect(readdirSafe(dir)).not.toContain(`s${i}.jsonl`)
    for (let i = total - RETENTION_FILES; i < total; i++) expect(readdirSafe(dir)).toContain(`s${i}.jsonl`)
  })

  it('sweep on a missing directory is a no-op', async () => {
    expect(await sweepReceipts(join(tmpdir(), 'cg-does-not-exist-xyz'))).toBeUndefined()
  })
})

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

describe('settings (§3.5 / §3.2 dual-half)', () => {
  it('defaults: enabled false, one nudge per session', () => {
    expect(DEFAULT_GATE_SETTINGS).toEqual({ enabled: false, 'nudges-per-session': 1 })
    expect(readUserSettingsSync(join(tmpdir(), 'no-such-home-xyz'))).toEqual(DEFAULT_GATE_SETTINGS)
  })

  it('raw user file is read live (hot read)', async () => {
    const home = tempDir()
    expect(readUserSettingsSync(home).enabled).toBe(false)
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ 'cc-completion-gate': { enabled: true, 'nudges-per-session': 3 } }), 'utf8')
    expect(readUserSettingsSync(home).enabled).toBe(true)
    expect(readUserSettingsSync(home)['nudges-per-session']).toBe(3)
    const asyncRead = await readUserSettings(home)
    expect(asyncRead.enabled).toBe(true)
    // Malformed file ⇒ fail-soft defaults.
    writeFileSync(join(home, 'settings.json'), '{nope', 'utf8')
    expect(readUserSettingsSync(home)).toEqual(DEFAULT_GATE_SETTINGS)
  })

  it('malformed section values fall back to ship defaults (fail-soft §3.5)', () => {
    const home = tempDir()
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ 'cc-completion-gate': { enabled: true, 'nudges-per-session': 'bogus' } }), 'utf8')
    expect(readUserSettingsSync(home)).toEqual(DEFAULT_GATE_SETTINGS)
  })
})
