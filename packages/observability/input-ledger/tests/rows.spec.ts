/**
 * Row-shape contract: every type in the single schema source round-trips
 * through JSON unchanged, carries the schema version, and the label cap bounds
 * the only free-form strings a row may carry.
 */

import { describe, expect, it } from 'vitest'
import type {
  AssembleRow,
  CapRow,
  DedupeRow,
  GovernorRow,
  LedgerRow,
  RequestRow,
  TrimAction,
} from '../src/index.ts'
import { clampLabel, LEDGER_SCHEMA_VERSION, MAX_LABEL_CHARS } from '../src/index.ts'

const base = { v: 1 as const, ts: 1_763_000_000_000, sessionId: 'session-1', gen: 'gen-abc' }

const assembleRow: AssembleRow = {
  ...base,
  type: 'assemble',
  isSubagent: false,
  sections: [
    { name: 'core/identity', bytes: 812, hash8: 'a1b2c3d4' },
    { name: 'core/tooling', bytes: 2048, hash8: 'deadbeef' },
  ],
  totalBytes: 2860,
  renderedFromCache: true,
}

const requestRow: RequestRow = {
  ...base,
  turn: 3,
  step: 7,
  type: 'request',
  seqPerGen: 12,
  provider: 'deepseek',
  model: 'deepseek-chat',
  mainLoop: true,
  systemBytes: 2860,
  systemHash8: '0f0f0f0f',
  toolsCount: 14,
  toolsBytes: 9120,
  messages: {
    count: 4,
    bytesTotal: 1200,
    nonTextBlocks: 2,
    bySourceKind: {
      user: { count: 1, bytes: 40 },
      assistant: { count: 2, bytes: 900 },
      'tool-result': { count: 1, bytes: 260 },
    },
    toolResults: { count: 1, bytes: 260 },
    assistantBytes: 900,
  },
}

const governorRow: GovernorRow = {
  ...base,
  type: 'governor',
  mode: 'enforce',
  bytesByClass: { instructions: 4096, evidence: 1024 },
  trimmed: [
    { kind: 'evidence', bytes: 1024, action: 'defer' },
    { kind: 'expired-evidence', bytes: 512, action: 'drop-expired' },
    { kind: 'log-tail', bytes: 65536, action: 'drop-oversize' },
  ],
  offeredBacklog: 2,
  hardOver: true,
}

const dedupeRow: DedupeRow = {
  ...base,
  type: 'dedupe',
  applied: true,
  kind: 'injection-hash',
  hash12: '0123456789ab',
  suppressedWithin: 4,
}

const capRow: CapRow = {
  ...base,
  type: 'cap',
  applied: false,
  kind: 'skill-body',
  runningCount: 3,
  suppressedTotal: 0,
}

/** Serialize and parse back the way the JSONL sink and readers do. */
function roundtrip(row: LedgerRow): LedgerRow {
  return JSON.parse(JSON.stringify(row)) as LedgerRow
}

describe('LedgerRow shapes', () => {
  it('pins the schema version to 1', () => {
    expect(LEDGER_SCHEMA_VERSION).toBe(1)
    expect(assembleRow.v).toBe(1)
  })

  it('round-trips an assemble row unchanged', () => {
    expect(roundtrip(assembleRow)).toEqual(assembleRow)
  })

  it('round-trips a request row unchanged', () => {
    expect(roundtrip(requestRow)).toEqual(requestRow)
  })

  it('round-trips a governor row unchanged and keeps the three trim actions', () => {
    const actions = roundtrip(governorRow).trimmed.map(trim => trim.action)
    const allowed: TrimAction[] = ['defer', 'drop-expired', 'drop-oversize']
    expect(roundtrip(governorRow)).toEqual(governorRow)
    expect(actions).toEqual(['defer', 'drop-expired', 'drop-oversize'])
    expect(actions.every(action => allowed.includes(action))).toBe(true)
  })

  it('round-trips a dedupe row unchanged', () => {
    expect(roundtrip(dedupeRow)).toEqual(dedupeRow)
  })

  it('round-trips a cap row unchanged', () => {
    expect(roundtrip(capRow)).toEqual(capRow)
  })

  it('omits turn and step for auxiliary calls instead of inheriting them', () => {
    const auxiliary: RequestRow = {
      v: 1,
      ts: base.ts,
      sessionId: 'session-1',
      gen: 'gen-abc',
      type: 'request',
      seqPerGen: 1,
      provider: 'deepseek',
      model: 'deepseek-chat',
      purpose: 'compaction',
      mainLoop: false,
      systemBytes: 0,
      systemHash8: 'e3b0c442',
      toolsCount: 0,
      toolsBytes: 0,
      messages: {
        count: 1,
        bytesTotal: 12,
        nonTextBlocks: 0,
        bySourceKind: { user: { count: 1, bytes: 12 } },
        toolResults: { count: 0, bytes: 0 },
        assistantBytes: 0,
      },
    }
    const serialized = JSON.stringify(auxiliary)
    expect(serialized).not.toContain('"turn"')
    expect(serialized).not.toContain('"step"')
    expect(roundtrip(auxiliary)).toEqual(auxiliary)
  })

  it('discriminates on type', () => {
    const rows: LedgerRow[] = [assembleRow, requestRow, governorRow, dedupeRow, capRow]
    expect(rows.map(row => row.type)).toEqual(['assemble', 'request', 'governor', 'dedupe', 'cap'])
  })
})

describe('clampLabel', () => {
  it('caps section names and source-kind strings at 64 chars by default', () => {
    const long = 'x'.repeat(200)
    expect(MAX_LABEL_CHARS).toBe(64)
    expect(clampLabel(long)).toHaveLength(64)
    expect(clampLabel(long)).toBe('x'.repeat(64))
  })

  it('leaves a label that already fits untouched', () => {
    expect(clampLabel('core/identity')).toBe('core/identity')
    expect(clampLabel('x'.repeat(64))).toBe('x'.repeat(64))
  })

  it('honors a tighter caller-chosen cap', () => {
    expect(clampLabel('core/identity', 4)).toBe('core')
  })

  it('truncates at code-unit boundaries, never mid multi-byte sequence', () => {
    const label = 'é'.repeat(70)
    const clamped = clampLabel(label)
    expect(clamped).toHaveLength(64)
    expect(Buffer.from(clamped, 'utf8').toString('utf8')).toBe(clamped)
  })
})
