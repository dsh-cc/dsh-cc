import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { buildReport, CACHE_METER_DISCLAIMER, foldUsage, renderReport, TAIL_APPEND_NOTE } from '@dsh-cc/cache-health/report'
import type { LedgerRow } from '@dsh-cc/cache-health/ledger'

function row(seq: number, prefixChanged = false, driftSegmentIndex?: number): LedgerRow {
  return {
    ts: '2026-09-10T00:00:00.000Z',
    seq,
    provider: 'deepseek',
    model: 'deepseek-chat',
    stableSegments: 3,
    stablePrefixTokensEst: 100,
    prefixChanged,
    ...(driftSegmentIndex !== undefined ? { driftSegmentIndex } : {}),
  }
}

function usageEvent(seq: number, cacheReadTokens: number, cacheWriteTokens = 0): SessionEvent {
  return {
    seq,
    time: seq,
    type: 'assistant/message',
    data: { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens, cacheWriteTokens } },
  } as unknown as SessionEvent
}

describe('foldUsage interval rule', () => {
  it('accrues usage to the row that closed the interval (seq in (row_i.seq, row_i+1.seq])', () => {
    const rows = [row(1), row(4)]
    const folds = foldUsage(rows, [usageEvent(2, 100), usageEvent(3, 200), usageEvent(5, 400)])
    // rows share boundaries: events 2,3 fall after row(1) and at/before row(4)'s seq
    // → row(1) takes (1,4] = events 2,3; row(4) takes everything after 4 = event 5.
    expect(folds[0]![1]).toEqual({ cacheReadTokens: 300, cacheWriteTokens: 0 })
    expect(folds[1]![1]).toEqual({ cacheReadTokens: 400, cacheWriteTokens: 0 })
  })

  it('shared-seq pair [5, 5]: events at 6, 7 accrue to the LAST row with that seq', () => {
    const rows = [row(5), row(5)]
    const folds = foldUsage(rows, [usageEvent(6, 100), usageEvent(7, 100)])
    expect(folds[0]![1]).toEqual({ cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(folds[1]![1]).toEqual({ cacheReadTokens: 200, cacheWriteTokens: 0 })
  })

  it('drops usage events at or before the first row seq (no-header pattern)', () => {
    const rows = [row(5)]
    const folds = foldUsage(rows, [usageEvent(3, 100), usageEvent(5, 100), usageEvent(6, 100)])
    expect(folds[0]![1].cacheReadTokens).toBe(100)
  })

  it('ignores events without usage', () => {
    const rows = [row(1)]
    const folds = foldUsage(rows, [{ seq: 2, time: 2, type: 'assistant/message', data: {} } as unknown as SessionEvent])
    expect(folds[0]![1]).toEqual({ cacheReadTokens: 0, cacheWriteTokens: 0 })
  })
})

describe('buildReport + renderReport', () => {
  it('splits drift rows into front-loaded suspects and tail appends', () => {
    const rows = [row(1, false), row(2, true, 0), row(3, true, 2), row(4, true, 5)]
    const report = buildReport(rows, [])
    expect(report.driftRows).toHaveLength(3)
    expect(report.frontLoadedSuspects.map(r => r.seq)).toEqual([2, 3])
    expect(report.tailAppends.map(r => r.seq)).toEqual([4])
    expect(report.current).toEqual({ stableSegments: 3, stablePrefixTokensEst: 100, changedSinceLastCall: true })
  })

  it('renders the exact disclaimers and an empty-ledger notice', () => {
    const text = renderReport(buildReport([row(1, true, 0)], []))
    expect(text).toContain(CACHE_METER_DISCLAIMER)
    expect(text).toContain(TAIL_APPEND_NOTE)
    expect(text).toContain('Front-loaded suspects')
    expect(renderReport(buildReport([], [])).startsWith('No cache-health data yet')).toBe(true)
  })

  it('renders per-call usage ratios and session totals', () => {
    const rows = [row(1), row(2)]
    const events = [usageEvent(2, 800, 200), usageEvent(3, 450, 50)]
    const text = renderReport(buildReport(rows, events))
    expect(text).toContain('read 800, write 200 (read share 80%)')
    expect(text).toContain('read 450, write 50 (read share 90%)')
    expect(text).toContain('Session totals: read 1250, write 250')
  })
})
