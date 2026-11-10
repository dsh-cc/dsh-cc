/**
 * Pins for the per-candidate grey-zone rule (PR-B): in-band rows are DROPPED
 * from selection instead of poisoning the whole run. The run-level abstention
 * was designed to protect uncertain candidates via the legacy fallback, but
 * on pools above the fallback cap (256) the legacy selector skips, so the
 * abstention delivered nothing while the decision model had a confident top
 * (measured p = 0.87-0.92 for the truly useful memory on the real corpus).
 * The empty-after-drop case converges with the existing empty-selection
 * fallback; the mixed case delivers the confident subset terminally (#366).
 */

import { describe, expect, it } from 'vitest'
import { selectIds } from '../src/recall-decision.ts'
import type { RecallProbabilityRow } from '../src/recall-decision.ts'

function row(id: string, probability: number, scope: 'workspace' | 'global' = 'workspace'): RecallProbabilityRow {
  return { id, probability, scope }
}

describe('selectIds — per-candidate grey-zone', () => {
  it('drops in-band rows instead of abstaining the whole run', () => {
    const result = selectIds([row('a', 0.9), row('b', 0.5), row('c', 0.1)], 0.25, 0.75)
    expect(result).toEqual({ ids: ['a'], greyDropped: 1 })
  })

  it('boundary equality is not grey: p === lo excluded, p === hi included, other rows in band', () => {
    const result = selectIds([row('lo', 0.25), row('hi', 0.75), row('mid', 0.5)], 0.25, 0.75)
    expect(result).toEqual({ ids: ['hi'], greyDropped: 1 })
  })

  it('greyDropped counts ALL in-band judged rows, independent of the selection cap', () => {
    const rows = [
      ...Array.from({ length: 7 }, (_, i) => row(`band${i}`, 0.3 + i * 0.05)),
      row('above1', 0.9), row('above2', 0.95), row('above3', 0.99),
    ]
    const result = selectIds(rows, 0.25, 0.75)
    expect(result).toEqual({ ids: ['above3', 'above2', 'above1'], greyDropped: 7 })
  })

  it('all-in-band yields an empty selection with the full greyDropped count', () => {
    expect(selectIds([row('a', 0.5), row('b', 0.4)], 0.25, 0.75)).toEqual({ ids: [], greyDropped: 2 })
  })

  it('all-low yields an empty selection with greyDropped 0', () => {
    expect(selectIds([row('a', 0.1)], 0.25, 0.75)).toEqual({ ids: [], greyDropped: 0 })
  })

  it('selection ordering is unchanged: probability desc, workspace first, then id bytes', () => {
    const result = selectIds([row('z', 0.9), row('a', 0.9), row('g', 0.9, 'global')], 0.25, 0.75)
    expect(result.ids).toEqual(['a', 'z', 'g'])
  })
})
