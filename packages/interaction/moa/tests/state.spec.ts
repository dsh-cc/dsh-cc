import { describe, expect, it } from 'vitest'
import { EscalationBookkeeping, isMoaEscalationMessage, MOA_ESCALATION_KIND } from '../src/state.ts'

describe('escalation bookkeeping (§4/§3.4)', () => {
  it('keying: floorFor is per origin seq, undefined when unrecorded', () => {
    const b = new EscalationBookkeeping()
    expect(b.floorFor(7)).toBeUndefined()
    b.recordFloor(7, 0)
    b.recordFloor(9, 1)
    expect(b.floorFor(7)).toBe(0)
    expect(b.floorFor(9)).toBe(1)
    expect(b.stateFor(7)).toEqual({ tierFloor: 0, retriesUsed: 0 })
  })

  it('floor never decreases (equal re-record allowed)', () => {
    const b = new EscalationBookkeeping()
    b.recordFloor(5, 2)
    expect(() => b.recordFloor(5, 1)).toThrow(/decrease/)
    b.recordFloor(5, 2)
    expect(b.floorFor(5)).toBe(2)
  })

  it('recordRetryUsed advances floor to toTier and counts retries', () => {
    const b = new EscalationBookkeeping()
    b.recordFloor(3, 0)
    b.recordRetryUsed(3, 0, 1)
    expect(b.floorFor(3)).toBe(1)
    expect(b.stateFor(3)).toEqual({ tierFloor: 1, retriesUsed: 1 })
  })

  it('recordRetryUsed permits a multi-rung jump but refuses backward/out-of-range transitions (§3.2)', () => {
    const b = new EscalationBookkeeping()
    b.recordFloor(3, 0)
    b.recordRetryUsed(3, 0, 2) // two-rung jump legal (same-model rung skipped)
    expect(b.floorFor(3)).toBe(2)
    expect(b.stateFor(3)).toEqual({ tierFloor: 2, retriesUsed: 1 })
    expect(() => b.recordRetryUsed(3, 1, 3)).toThrow(/live floor/)
    expect(() => b.recordRetryUsed(3, 2, 1)).toThrow(/does not exceed/)
    expect(() => b.recordRetryUsed(3, 2, 2)).toThrow(/does not exceed/)
    expect(() => b.recordRetryUsed(3, 2, 4)).toThrow(/out of range/)
    b.recordRetryUsed(3, 2, 3)
    expect(b.stateFor(3)).toEqual({ tierFloor: 3, retriesUsed: 2 })
    expect(() => b.recordRetryUsed(3, 0, 1)).toThrow(/live floor/)
  })

  it('invalid inputs throw (bugs, not runtime conditions)', () => {
    const b = new EscalationBookkeeping()
    expect(() => b.recordFloor(-1, 0)).toThrow(/seq/)
    expect(() => b.recordFloor(1, 1.5)).toThrow(/tier/)
  })

  it('F-3: restoreFromEscalations rebuilds floor + retry count from the durable followup chain', () => {
    const b = new EscalationBookkeeping()
    b.restoreFromEscalations(4, [{ fromTier: 0, toTier: 1 }, { fromTier: 1, toTier: 3 }])
    expect(b.stateFor(4)).toEqual({ tierFloor: 3, retriesUsed: 2 })
    // The judge's retry accounting continues from the restored state.
    expect(() => b.recordRetryUsed(4, 3, 3)).toThrow(/does not exceed/)
  })

  it('F-3: restoreFromEscalations is monotonic — never lowers a live floor or retry count', () => {
    const b = new EscalationBookkeeping()
    b.recordFloor(4, 0)
    b.recordRetryUsed(4, 0, 2)
    b.recordRetryUsed(4, 2, 3) // live: floor 3, retries 2
    b.restoreFromEscalations(4, [{ fromTier: 0, toTier: 1 }])
    expect(b.stateFor(4)).toEqual({ tierFloor: 3, retriesUsed: 2 })
  })

  it('F-3: restoreFromEscalations refuses malformed records (out of range, non-integer, not increasing, empty)', () => {
    const b = new EscalationBookkeeping()
    expect(() => b.restoreFromEscalations(1, [{ fromTier: 0, toTier: 99 }])).toThrow(/malformed/)
    expect(() => b.restoreFromEscalations(1, [{ fromTier: 0, toTier: 1.5 }])).toThrow(/malformed/)
    expect(() => b.restoreFromEscalations(1, [{ fromTier: 2, toTier: 2 }])).toThrow(/malformed/)
    expect(() => b.restoreFromEscalations(1, [])).toThrow(/no escalation records/)
    expect(b.floorFor(1)).toBeUndefined()
  })

  it('typed provenance guard accepts and rejects (§3.4)', () => {
    expect(isMoaEscalationMessage({ kind: MOA_ESCALATION_KIND, originSeq: 1, fromTier: 0, toTier: 1 })).toBe(true)
    expect(isMoaEscalationMessage({ kind: 'user' })).toBe(false)
    expect(isMoaEscalationMessage({ kind: MOA_ESCALATION_KIND, originSeq: 'x', fromTier: 0, toTier: 1 })).toBe(false)
    expect(isMoaEscalationMessage(undefined)).toBe(false)
    expect(isMoaEscalationMessage(null)).toBe(false)
  })
})
