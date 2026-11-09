/**
 * Durable ledger unit tests (design §"Ledger, privacy and reporting",
 * §"Durable quota and concurrency"): fsync append + torn-tail repair, the
 * detecting reader (blank lines skipped, torn/corrupt lines REPORTED), and
 * the accounting projection's recovery rules (unpaired reserve keeps full,
 * only durable not-dispatched refunds, freeze markers read back).
 * All legs run in tmpdirs — the real dsh home is never touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DecisionLedgerRow } from '@dsh-cc/systemone'
import {
  appendDecisionRow,
  decisionUsageDir,
  isDecisionLedgerRow,
  lockFilePath,
  projectDecisionLedger,
  readDecisionLedger,
  usageFilePath,
} from '../src/ledger.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'decision-usage-ledger-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

let eventCounter = 0
const nextEventId = (): string => `evt-${++eventCounter}`

/** Raw file write for corruption fixtures (appendDecisionRow mkdirs; sync writes don't). */
function writeRaw(file: string, content: string, append = false): void {
  mkdirSync(dirname(file), { recursive: true })
  if (append) appendFileSync(file, content, 'utf8')
  else writeFileSync(file, content, 'utf8')
}

function rowOf(over: Partial<DecisionLedgerRow> = {}): DecisionLedgerRow {
  return {
    schemaVersion: 1,
    eventId: nextEventId(),
    decisionId: 'dec-1',
    attempt: 1,
    phase: 'reserve',
    time: 1_700_000_000_000,
    scope: { projectKey: 'proj-1', sessionId: 'sess-1', agentId: 'agent-1', originSeq: 2 },
    feature: 'moa-acceptance',
    mode: 'active',
    provider: 'testone',
    requestedModel: 's1-wire',
    actualModel: null,
    routeRevision: 'rev-1',
    questionVersion: 'qv1',
    policyVersion: 'pv1',
    inputHash: 'hash-1',
    reservedInputTokens: 100,
    reservedOutputTokens: 10,
    latencyMs: 0,
    outcome: 'reserved',
    ...over,
  }
}

function settleRow(
  outcome: 'actual' | 'unknown' | 'not-dispatched' = 'actual',
  actualInOut: { input: number; output: number } = { input: 40, output: 8 },
  over: Partial<DecisionLedgerRow> = {},
): DecisionLedgerRow {
  const row = rowOf({ phase: 'settle', outcome, ...over })
  if (outcome === 'actual') {
    row.actualInputTokens = actualInOut.input
    row.actualOutputTokens = actualInOut.output
  }
  return row
}

function dispatchRow(over: Partial<DecisionLedgerRow> = {}): DecisionLedgerRow {
  return rowOf({ phase: 'dispatch', outcome: 'dispatched', ...over })
}

describe('path construction', () => {
  it('builds the decision-usage directory with an encoded session id', () => {
    const dir = decisionUsageDir('/home/dsh', 'proj-1', 'sess/../evil')
    expect(dir.startsWith(join('/home/dsh', 'decision-usage', 'proj-1'))).toBe(true)
    const segment = dir.slice(join('/home/dsh', 'decision-usage', 'proj-1').length + 1)
    expect(segment).not.toContain('/')
    // encodeSegment neutralizes traversal: the whole id is ONE safe segment.
    expect(segment).not.toBe('..')
    expect(segment).not.toBe('.')
    expect(usageFilePath(dir)).toBe(join(dir, 'usage.jsonl'))
    expect(lockFilePath(dir)).toBe(join(dir, 'quota.lock'))
  })
})

describe('appendDecisionRow + readDecisionLedger', () => {
  it('round-trips rows with a trailing newline per row', async () => {
    const file = usageFilePath(join(tmp, 'a', 'b'))
    await appendDecisionRow(file, rowOf({ eventId: 'e-1' }))
    await appendDecisionRow(file, rowOf({ eventId: 'e-2', phase: 'dispatch', outcome: 'dispatched' }))
    const raw = readFileSync(file, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw.split('\n').filter((l) => l.length > 0)).toHaveLength(2)
    const report = await readDecisionLedger(file)
    expect(report.tornTail).toBe(false)
    expect(report.corruptLines).toEqual([])
    expect(report.rows.map((r) => r.eventId)).toEqual(['e-1', 'e-2'])
    expect(report.bytes).toBe(statSync(file).size)
  })

  it('creates missing parent directories', async () => {
    const file = usageFilePath(join(tmp, 'deep', 'nested', 'dir'))
    await appendDecisionRow(file, rowOf())
    expect(existsSync(file)).toBe(true)
  })

  it('reads a missing file as empty without torn state', async () => {
    const report = await readDecisionLedger(join(tmp, 'nope', 'usage.jsonl'))
    expect(report.rows).toEqual([])
    expect(report.tornTail).toBe(false)
    expect(report.corruptLines).toEqual([])
    expect(report.bytes).toBe(0)
  })

  it('rethrows non-ENOENT read failures (an unreadable ledger is not an empty one)', async () => {
    const file = usageFilePath(join(tmp, 'locked'))
    await appendDecisionRow(file, rowOf())
    chmodSync(file, 0o000)
    try {
      await expect(readDecisionLedger(file)).rejects.toThrow()
    } finally {
      chmodSync(file, 0o600)
    }
  })

  it('skips blank lines', async () => {
    const file = usageFilePath(join(tmp, 'blank'))
    writeRaw(file, `${JSON.stringify(rowOf({ eventId: 'e-1' }))}\n\n\n`)
    const report = await readDecisionLedger(file)
    expect(report.rows).toHaveLength(1)
    expect(report.tornTail).toBe(false)
    expect(report.corruptLines).toEqual([])
  })

  it('DETECTS a torn tail line instead of silently skipping it', async () => {
    const file = usageFilePath(join(tmp, 'torn'))
    writeRaw(file, `${JSON.stringify(rowOf({ eventId: 'e-1' }))}\n{"schemaVersion":1,"eventId":"e-2","decisionI`)
    const report = await readDecisionLedger(file)
    expect(report.tornTail).toBe(true)
    expect(report.corruptLines).toEqual([2])
    expect(report.rows.map((r) => r.eventId)).toEqual(['e-1'])
  })

  it('flags a non-conforming JSON line as corrupt even without a torn tail', async () => {
    const file = usageFilePath(join(tmp, 'corrupt'))
    writeRaw(
      file,
      `${JSON.stringify(rowOf({ eventId: 'e-1' }))}\n{"not":"a ledger row"}\n${JSON.stringify(rowOf({ eventId: 'e-3', phase: 'dispatch' }))}\n`,
    )
    const report = await readDecisionLedger(file)
    expect(report.tornTail).toBe(false)
    expect(report.corruptLines).toEqual([2])
    expect(report.rows.map((r) => r.eventId)).toEqual(['e-1', 'e-3'])
  })

  it('terminates a torn tail before appending (the fragment can never swallow a row)', async () => {
    const file = usageFilePath(join(tmp, 'repair'))
    writeRaw(file, `${JSON.stringify(rowOf({ eventId: 'e-1' }))}\n{"schemaVersion":1`, true)
    await appendDecisionRow(file, rowOf({ eventId: 'e-2', phase: 'dispatch' }))
    const report = await readDecisionLedger(file)
    expect(report.tornTail).toBe(false)
    expect(report.corruptLines).toEqual([2])
    expect(report.rows.map((r) => r.eventId)).toEqual(['e-1', 'e-2'])
  })
})

describe('isDecisionLedgerRow', () => {
  it('accepts the writer output and rejects drifted shapes', () => {
    expect(isDecisionLedgerRow(rowOf())).toBe(true)
    expect(isDecisionLedgerRow(rowOf({ schemaVersion: 2 as never }))).toBe(false)
    expect(isDecisionLedgerRow(rowOf({ phase: 'weird' as never }))).toBe(false)
    expect(isDecisionLedgerRow(rowOf({ outcome: 'wonky' as never }))).toBe(false)
    expect(isDecisionLedgerRow(rowOf({ reasonCode: 'made-up' as never }))).toBe(false)
    expect(isDecisionLedgerRow(rowOf({ attempt: -1 }))).toBe(false)
    expect(isDecisionLedgerRow(rowOf({ reservedInputTokens: 1.5 }))).toBe(false)
    expect(isDecisionLedgerRow(null)).toBe(false)
    expect(isDecisionLedgerRow('row')).toBe(false)
  })
})

describe('projectDecisionLedger (recovery accounting)', () => {
  it('retains the full reservation for an unpaired reserve and counts the attempt', () => {
    const projection = projectDecisionLedger([rowOf()])
    expect(projection.attemptsUsed).toBe(1)
    expect(projection.retainedInputTokens).toBe(100)
    expect(projection.retainedOutputTokens).toBe(10)
    expect(projection.frozen).toBe(false)
  })

  it('actual settle retains only actuals', () => {
    const projection = projectDecisionLedger([rowOf(), dispatchRow(), settleRow()])
    expect(projection.retainedInputTokens).toBe(40)
    expect(projection.retainedOutputTokens).toBe(8)
    expect(projection.attemptsUsed).toBe(1)
  })

  it('unknown settle keeps the full reservation (upper bound retained)', () => {
    const projection = projectDecisionLedger([rowOf(), settleRow('unknown')])
    expect(projection.retainedInputTokens).toBe(100)
    expect(projection.retainedOutputTokens).toBe(10)
  })

  it('a durable not-dispatched refunds in full and un-counts the attempt', () => {
    const projection = projectDecisionLedger([rowOf(), settleRow('not-dispatched')])
    expect(projection.retainedInputTokens).toBe(0)
    expect(projection.retainedOutputTokens).toBe(0)
    expect(projection.attemptsUsed).toBe(0)
  })

  it('an idempotent repeat settle charges nothing more; a conflicting one is counted', () => {
    const repeated = projectDecisionLedger([rowOf(), settleRow(), settleRow()])
    expect(repeated.retainedInputTokens).toBe(40)
    expect(repeated.conflictingSettles).toBe(0)
    const conflicting = projectDecisionLedger([rowOf(), settleRow(), settleRow('actual', { input: 41, output: 8 })])
    expect(conflicting.retainedInputTokens).toBe(40)
    expect(conflicting.conflictingSettles).toBe(1)
  })

  it('reads freeze markers back and never treats model-version-mismatch as one', () => {
    const frozen = projectDecisionLedger([
      rowOf(),
      rowOf({ phase: 'outcome', outcome: 'budget', reasonCode: 'quota-frozen' }),
    ])
    expect(frozen.frozen).toBe(true)
    expect(frozen.freezeReasonCode).toBe('quota-frozen')
    const overrun = projectDecisionLedger([
      rowOf(),
      rowOf({ phase: 'outcome', outcome: 'malformed', reasonCode: 'accounting-overrun', actualModel: 's1-ckpt-2' }),
    ])
    expect(overrun.frozen).toBe(true)
    expect(overrun.freezeReasonCode).toBe('accounting-overrun')
    const mismatch = projectDecisionLedger([
      rowOf(),
      rowOf({ phase: 'outcome', outcome: 'malformed', reasonCode: 'model-version-mismatch', actualModel: 's1-other' }),
    ])
    expect(mismatch.frozen).toBe(false)
  })

  it('attributes provider/requestedModel/actualModel per lease for /cost-style readers', () => {
    const projection = projectDecisionLedger([
      rowOf({ provider: '', requestedModel: '' }),
      dispatchRow(),
      settleRow('actual', { input: 40, output: 8 }, { actualModel: 's1-ckpt-2026' }),
    ])
    const lease = projection.leases[0]
    expect(lease?.provider).toBe('testone')
    expect(lease?.requestedModel).toBe('s1-wire')
    expect(lease?.actualModel).toBe('s1-ckpt-2026')
    expect(lease?.dispatched).toBe(true)
    expect(lease?.settledKind).toBe('actual')
  })
})
