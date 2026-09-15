import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, stat, writeFile, utimes, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendLedgerRow, loadSummaries, sweepLedgers } from '../src/ledger.ts'
import type { SummaryRow } from '../src/types.ts'

const dirs: string[] = []

afterEach(async () => {
  // rm not imported until needed; cleanup via rmSync is fine here
  const { rmSync } = await import('node:fs')
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function row(over: Partial<SummaryRow> = {}): SummaryRow {
  return {
    callId: 'c1',
    tool: 'read',
    resultBytes: 5000,
    status: 'ok',
    summary: 'edited src/a.ts: 3 changes',
    inheritedRoute: false,
    durationMs: 12,
    at: '2026-09-15T00:00:00.000Z',
    ...over,
  }
}

describe('ledger round-trip', () => {
  it('appends rows and loadSummaries reads them back keyed by callId', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tus-home-'))
    dirs.push(home)
    await appendLedgerRow(join(home, 'tool-use-summary', 's1.jsonl'), row())
    await appendLedgerRow(join(home, 'tool-use-summary', 's1.jsonl'), row({ callId: 'c2', status: 'skipped', skipReason: 'small', summary: undefined, inheritedRoute: undefined }))
    const summaries = await loadSummaries(home, 's1')
    expect([...summaries.keys()].sort()).toEqual(['c1', 'c2'])
    expect(summaries.get('c1')).toMatchObject({ status: 'ok', summary: 'edited src/a.ts: 3 changes' })
    expect(summaries.get('c2')).toMatchObject({ status: 'skipped', skipReason: 'small' })
  })

  it('tolerates a truncated tail line', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tus-home-'))
    dirs.push(home)
    const file = join(home, 'tool-use-summary', 's1.jsonl')
    await mkdir(join(home, 'tool-use-summary'), { recursive: true })
    await writeFile(file, `${JSON.stringify(row())}\n${JSON.stringify(row({ callId: 'c2' })).slice(0, 20)}`, 'utf8')
    const summaries = await loadSummaries(home, 's1')
    expect([...summaries.keys()]).toEqual(['c1'])
  })

  it('absent file → empty map', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tus-home-'))
    dirs.push(home)
    expect((await loadSummaries(home, 'nope')).size).toBe(0)
  })
})

describe('retention sweep', () => {
  it('removes ledger files older than retentionDays and keeps fresh ones', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tus-home-'))
    dirs.push(home)
    const dir = join(home, 'tool-use-summary')
    await mkdir(dir, { recursive: true })
    const old = join(dir, 'old.jsonl')
    const fresh = join(dir, 'fresh.jsonl')
    await writeFile(old, 'x\n', 'utf8')
    await writeFile(fresh, 'y\n', 'utf8')
    const aged = new Date(Date.now() - 8 * 24 * 3600 * 1000)
    await utimes(old, aged, aged)
    const removed = await sweepLedgers(home, 7)
    expect(removed).toBe(1)
    expect((await readdir(dir)).sort()).toEqual(['fresh.jsonl'])
  })

  it('sweep is a no-op when the directory is absent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tus-home-'))
    dirs.push(home)
    await expect(sweepLedgers(home, 7)).resolves.toBe(0)
  })
})

describe('appendLedgerRow error swallowing', () => {
  it('never throws on an unwritable path', async () => {
    const bad = join(await mkdtemp(join(tmpdir(), 'tus-home-')), 'file-blocks-dir')
    dirs.push(bad)
    await writeFile(bad, 'not a dir', 'utf8')
    await expect(appendLedgerRow(join(bad, 'x.jsonl'), row())).resolves.toBeUndefined()
  })
})

describe('file layout', () => {
  it('writes one JSONL row per append', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tus-home-'))
    dirs.push(home)
    const file = join(home, 'tool-use-summary', 's1.jsonl')
    await appendLedgerRow(file, row())
    const raw = await readFile(file, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw.trim().split('\n')).toHaveLength(1)
    expect((await stat(file)).isFile()).toBe(true)
  })
})
