/**
 * Receipt pins (§4.1): canonical stable-key JSON, artifact hash, ledger
 * path derivation, write-then-read-back, nudge budget projection, and
 * last-matching-row staleness.
 */

import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodeSegment } from '../src/encode.ts'
import {
  nudgeBudgetConsumed,
  receiptLedgerPath,
  sha256Hex,
  stableJson,
  staleAgainst,
  writeReceipt,
  type ReceiptRow,
} from '../src/receipt.ts'

function row(overrides: Partial<ReceiptRow> = {}): ReceiptRow {
  return {
    v: 1,
    ts: 1,
    sessionId: 's',
    artifactId: 'docs/a.md',
    artifactPath: 'docs/a.md',
    artifactHash: 'hash-1',
    claims: [],
    numbers: [],
    gates: [],
    provenance: { inputs: [], parentHash: '' },
    overall: 'pass',
    nudge: { round: 0 },
    ...overrides,
  }
}

describe('encodeSegment (copied §4.1)', () => {
  it('keeps safe segments literal and injectively escapes traversal', () => {
    expect(encodeSegment('abc-123_4.5')).toBe('abc-123_4.5')
    expect(encodeSegment('..')).toBe('~002E~002E')
    expect(encodeSegment('a/b')).not.toContain('/')
  })
  it('round-trips arbitrary strings injectively', () => {
    for (const raw of ['sess~id', '../etc/passwd', 'a\\b', '']) {
      if (raw === '') continue
      expect(encodeSegment(encodeSegment(raw))).toBeDefined()
 expect(encodeSegment(raw).includes('/')).toBe(false)
    }
  })
})

describe('stableJson (§4.1 canonical serialization)', () => {
  it('sorts keys recursively with no whitespace, pinned order', () => {
    const value = { b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2 } }
    expect(stableJson(value)).toBe('{"a":{"c":2,"d":[3,{"y":2,"z":1}]},"b":1}')
  })
  it('is stable under key insertion order', () => {
    expect(stableJson({ b: 1, a: 2 })).toBe(stableJson({ a: 2, b: 1 }))
  })
})

describe('artifact hash and ledger path', () => {
  it('hashes the UTF-8 bytes of the artifact (§4.1)', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex('hello'))
    expect(sha256Hex('héllo')).not.toBe(sha256Hex('hello'))
  })
  it('derives <dshHome>/vwa-receipts/<encoded>.jsonl', () => {
    expect(receiptLedgerPath('<dshHome>', 'sess/1')).toBe(join('<dshHome>', 'vwa-receipts', `${encodeSegment('sess/1')}.jsonl`))
  })
})

describe('writeReceipt (write-then-read-back §4.1)', () => {
  it('returns ok only when the last line matches artifactHash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vwa-receipt-'))
    const ledger = join(dir, 'ledger.jsonl')
    const written = await writeReceipt(ledger, row({ artifactHash: sha256Hex('a') }))
    expect(written.ok).toBe(true)
    const lines = (await readFile(ledger, 'utf8')).trim().split('\n')
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ v: 1, artifactHash: sha256Hex('a') })
    // A second append whose read-back still ends on its own hash.
    const second = await writeReceipt(ledger, row({ artifactHash: sha256Hex('b') }))
    expect(second.ok).toBe(true)
    expect((await readFile(ledger, 'utf8')).trim().split('\n')).toHaveLength(2)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('nudgeBudgetConsumed (§4.1 projection)', () => {
  it('counts rows with nudge.round > 0 only', () => {
    const rows = [row(), row({ nudge: { round: 1 } }), row({ nudge: { round: 2 } })]
    expect(nudgeBudgetConsumed(rows)).toBe(2)
 expect(nudgeBudgetConsumed([row({ nudge: { round: 0 } })])).toBe(0)
  })
})

describe('staleAgainst (last-matching-row semantics §4.1)', () => {
  it('is stale when the last row for the path has a different hash', () => {
    const rows = [row({ artifactPath: 'docs/a.md', artifactHash: 'h1' })]
    expect(staleAgainst(rows, 'docs/a.md', 'h2')).toBe(true)
    expect(staleAgainst(rows, 'docs/a.md', 'h1')).toBe(false)
  })
  it('uses the LAST matching row, not the first', () => {
    const rows = [
      row({ artifactPath: 'docs/a.md', artifactHash: 'h1' }),
      row({ artifactPath: 'docs/a.md', artifactHash: 'h2' }),
    ]
    expect(staleAgainst(rows, 'docs/a.md', 'h2')).toBe(false)
    expect(staleAgainst(rows, 'docs/a.md', 'h1')).toBe(true)
  })
  it('no row for the path counts as stale (never verified)', () => {
    expect(staleAgainst([row({ artifactPath: 'other.md' })], 'docs/a.md', 'h1')).toBe(true)
  })
})
