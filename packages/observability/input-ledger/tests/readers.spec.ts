/**
 * Reader contract: each typed reader yields only its own row type and skips
 * rows of other types, unparseable lines, wrong-version rows and a torn final
 * line. A missing file yields nothing.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readAssembleRows,
  readCapRows,
  readDedupeRows,
  readGovernorRows,
  readRequestRows,
} from '../src/index.ts'

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const row of rows) out.push(row)
  return out
}

const base = { v: 1 as const, ts: 1_763_000_000_000, sessionId: 'session-1', gen: 'gen-abc' }

const assembleRow = {
  ...base,
  type: 'assemble',
  isSubagent: false,
  sections: [{ name: 'core/identity', bytes: 10, hash8: 'a1b2c3d4' }],
  totalBytes: 10,
  renderedFromCache: false,
}

const requestRow = {
  ...base,
  type: 'request',
  seqPerGen: 1,
  provider: 'deepseek',
  model: 'deepseek-chat',
  mainLoop: true,
  systemBytes: 10,
  systemHash8: 'e3b0c442',
  toolsCount: 0,
  toolsBytes: 0,
  messages: {
    count: 0,
    bytesTotal: 0,
    nonTextBlocks: 0,
    bySourceKind: {},
    toolResults: { count: 0, bytes: 0 },
    assistantBytes: 0,
  },
}

const governorRow = {
  ...base,
  type: 'governor',
  mode: 'observe',
  bytesByClass: { evidence: 64 },
  trimmed: [{ kind: 'evidence', bytes: 64, action: 'defer' }],
  offeredBacklog: 1,
  hardOver: false,
}

const dedupeRow = {
  ...base,
  type: 'dedupe',
  applied: true,
  kind: 'injection-hash',
  hash12: '0123456789ab',
  suppressedWithin: 2,
}

const capRow = {
  ...base,
  type: 'cap',
  applied: false,
  kind: 'skill-body',
  runningCount: 1,
  suppressedTotal: 0,
}

/** Mixed ledger: every type, plus lines a reader must skip. */
async function mixedLedger(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'input-ledger-readers-'))
  const file = join(dir, 'ledger.jsonl')
  const lines = [
    JSON.stringify(assembleRow),
    JSON.stringify(requestRow),
    '',
    'not json at all',
    JSON.stringify({ ...assembleRow, v: 2 }),
    JSON.stringify({ ...capRow, type: 'mystery' }),
    JSON.stringify(governorRow),
    JSON.stringify(dedupeRow),
    JSON.stringify(capRow),
    '{"v":1,"type":"request"',
  ]
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8')
  return file
}

describe('typed readers', () => {
  it('readAssembleRows yields only assemble rows', async () => {
    const rows = await collect(readAssembleRows(await mixedLedger()))
    expect(rows).toEqual([assembleRow])
  })

  it('readRequestRows yields only request rows and tolerates the torn tail', async () => {
    const rows = await collect(readRequestRows(await mixedLedger()))
    expect(rows).toEqual([requestRow])
  })

  it('readGovernorRows yields only governor rows', async () => {
    const rows = await collect(readGovernorRows(await mixedLedger()))
    expect(rows).toEqual([governorRow])
  })

  it('readDedupeRows yields only dedupe rows', async () => {
    const rows = await collect(readDedupeRows(await mixedLedger()))
    expect(rows).toEqual([dedupeRow])
  })

  it('readCapRows yields only cap rows with a known type and version', async () => {
    const rows = await collect(readCapRows(await mixedLedger()))
    expect(rows).toEqual([capRow])
  })

  it('yields nothing for a missing file', async () => {
    expect(await collect(readRequestRows(join(tmpdir(), 'input-ledger-does-not-exist.jsonl')))).toEqual([])
  })

  it('is usable as a for-await iterable directly', async () => {
    const seen: string[] = []
    for await (const row of readCapRows(await mixedLedger())) seen.push(row.kind)
    expect(seen).toEqual(['skill-body'])
  })
})
