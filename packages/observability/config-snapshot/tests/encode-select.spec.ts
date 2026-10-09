/**
 * §5 item 1 (part): hostile-id filename encoding and the normative
 * row-selection rule over a two-row file (§3.4).
 */
import { describe, expect, it } from 'vitest'
import { encodeSegment } from '../src/encode.ts'
import { selectRow, type SnapshotRow } from '../src/row.ts'

function rowOf(sessionId: string, seq: number, appendedAt: number): SnapshotRow {
  return {
    schemaVersion: 1,
    sessionId,
    seq,
    bootId: 'boot',
    appendedAt,
    dshCc: '0.9.0-rc.3',
    harness: null,
    preset: { id: null },
    plugins: [],
    delegationDepth: 0,
    parentSession: null,
    origin: null,
  }
}

describe('encodeSegment hostile session ids', () => {
  it.each([
    '../',
    '/',
    '..',
    '.',
  ])('encodes %j as a single safe path component', (id) => {
    const encoded = encodeSegment(id)
    expect(encoded).not.toContain('/')
    expect(encoded).not.toBe('.')
    expect(encoded).not.toBe('..')
    expect(encoded.length).toBeGreaterThan(0)
  })

  it('is injective over colliding-looking ids', () => {
    expect(encodeSegment('a/b')).not.toBe(encodeSegment('a~2Fb'))
    expect(encodeSegment('..')).toBe('~002E~002E')
    expect(encodeSegment('..')).not.toBe(encodeSegment('.'))
  })
})

describe('selectRow (§3.4 rule)', () => {
  const rows: SnapshotRow[] = [
    rowOf('s', 1, 1000),
    rowOf('s', 2, 2000),
  ]

  it('event before the first row ⇒ unknown', () => {
    expect(selectRow(rows, 999)).toBeNull()
  })

  it('event between rows ⇒ row 1', () => {
    expect(selectRow(rows, 1500)?.seq).toBe(1)
  })

  it('event after the last row ⇒ row 2', () => {
    expect(selectRow(rows, 3000)).toMatchObject({ seq: 2 })
  })

  it('same-millisecond tie ⇒ seq breaks it (later file order wins)', () => {
    const tied: SnapshotRow[] = [
      rowOf('s', 7, 1000),
      rowOf('s', 9, 1000),
      rowOf('s', 8, 1000),
    ]
    expect(selectRow(tied, 1000)?.seq).toBe(9)
  })
})
