/**
 * Sink contract: path encoding, append/read roundtrip, rotation at the row cap,
 * dropped-row health on write failure, and the no-dshHome no-op.
 */

import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CapRow } from '../src/index.ts'
import {
  appendLedgerRow,
  DEFAULT_MAX_ROWS_PER_FILE,
  getLedgerHealth,
  LEDGER_DIR_NAME,
  sessionLedgerPath,
} from '../src/index.ts'

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function tempDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'input-ledger-'))
  return dir
}

function capRow(runningCount: number): CapRow {
  return {
    v: 1,
    ts: 1_763_000_000_000 + runningCount,
    sessionId: 'session-1',
    gen: 'gen-test',
    type: 'cap',
    applied: false,
    kind: 'skill-body',
    runningCount,
    suppressedTotal: 0,
  }
}

async function readLines(file: string): Promise<string[]> {
  const raw = await readFile(file, 'utf8')
  return raw.split('\n').filter(line => line.length > 0)
}

describe('sessionLedgerPath', () => {
  it('joins under <dshHome>/input-ledger/<projectKey>/ and encodes the session id', () => {
    const file = sessionLedgerPath('/home/u/.dsh', 'abc123', 'a/b')
    expect(file).toBe(join('/home/u/.dsh', LEDGER_DIR_NAME, 'abc123', 'a~002Fb.jsonl'))
  })

  it('encodes traversal-shaped session ids as one safe segment', () => {
    expect(sessionLedgerPath('/dsh', 'k', '..')).toBe(join('/dsh', LEDGER_DIR_NAME, 'k', '~002E~002E.jsonl'))
    expect(sessionLedgerPath('/dsh', 'k', '../escape')).not.toContain('..' + '/')
  })
})

describe('appendLedgerRow', () => {
  it('appends one JSON row per line and creates parent directories', async () => {
    const root = await tempDir()
    const file = sessionLedgerPath(root, 'project', 'session-1')
    await appendLedgerRow(file, capRow(1))
    await appendLedgerRow(file, capRow(2))
    expect(await readLines(file)).toEqual([
      JSON.stringify(capRow(1)),
      JSON.stringify(capRow(2)),
    ])
  })

  it('is a no-op when dshHome is absent', async () => {
    const before = getLedgerHealth().droppedRows
    await expect(appendLedgerRow(undefined, capRow(0))).resolves.toBeUndefined()
    expect(getLedgerHealth().droppedRows).toBe(before)
  })
})

describe('appendLedgerRow rotation', () => {
  it('rotates at the cap: writing the cap+Nth row archives the file and starts a fresh one', async () => {
    const root = await tempDir()
    const file = join(root, 'ledger.jsonl')
    const cap = DEFAULT_MAX_ROWS_PER_FILE
    for (let i = 0; i < cap; i++) await appendLedgerRow(file, capRow(i))
    expect(await readLines(file)).toHaveLength(cap)
    await expect(stat(`${file}.1`)).rejects.toThrow()

    await appendLedgerRow(file, capRow(cap))

    expect(await readLines(`${file}.1`)).toHaveLength(cap)
    expect(await readLines(file)).toHaveLength(1)
    const fresh = JSON.parse((await readLines(file))[0] ?? '{}') as CapRow
    expect(fresh.runningCount).toBe(cap)
  })

  it('clobbers the previous archive instead of accumulating rotations', async () => {
    const root = await tempDir()
    const file = join(root, 'ledger.jsonl')
    const cap = DEFAULT_MAX_ROWS_PER_FILE
    for (let i = 0; i < cap + 1; i++) await appendLedgerRow(file, capRow(i))
    // Second rotation: the fresh file fills back up to the cap, then archives.
    for (let i = 0; i < cap - 1; i++) await appendLedgerRow(file, capRow(cap + 1 + i))
    await appendLedgerRow(file, capRow(2 * cap))
    const archive = await readLines(`${file}.1`)
    expect(archive).toHaveLength(cap)
    expect((JSON.parse(archive[0] ?? '{}') as CapRow).runningCount).toBe(cap)
    expect(await readLines(file)).toHaveLength(1)
  })
})

describe('appendLedgerRow error path', () => {
  it('counts a failed append as a dropped row and reports it to onError', async () => {
    const root = await tempDir()
    const blocked = join(root, 'blocked')
    await writeFile(blocked, 'not a dir')
    await chmod(blocked, 0o444)
    const before = getLedgerHealth().droppedRows
    const seen: unknown[] = []

    await expect(
      appendLedgerRow(join(blocked, 'ledger.jsonl'), capRow(0), (err) => seen.push(err)),
    ).resolves.toBeUndefined()

    expect(getLedgerHealth().droppedRows).toBe(before + 1)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(Error)
  })

  it('never rejects when the onError sink throws', async () => {
    const root = await tempDir()
    const blocked = join(root, 'blocked')
    await writeFile(blocked, 'not a dir')
    await chmod(blocked, 0o444)
    await expect(
      appendLedgerRow(join(blocked, 'ledger.jsonl'), capRow(0), () => {
        throw new Error('sink failure')
      }),
    ).resolves.toBeUndefined()
  })
})
