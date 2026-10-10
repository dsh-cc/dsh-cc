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

  it('recordRetryUsed asserts toTier === floor+1 and fromTier === live floor', () => {
    const b = new EscalationBookkeeping()
    b.recordFloor(3, 0)
    expect(() => b.recordRetryUsed(3, 0, 2)).toThrow(/floor\+1/)
    expect(() => b.recordRetryUsed(3, 1, 2)).toThrow(/live floor/)
    b.recordRetryUsed(3, 0, 1)
    expect(() => b.recordRetryUsed(3, 0, 1)).toThrow(/live floor/)
  })

  it('invalid inputs throw (bugs, not runtime conditions)', () => {
    const b = new EscalationBookkeeping()
    expect(() => b.recordFloor(-1, 0)).toThrow(/seq/)
    expect(() => b.recordFloor(1, 1.5)).toThrow(/tier/)
  })

  it('typed provenance guard accepts and rejects (§3.4)', () => {
    expect(isMoaEscalationMessage({ kind: MOA_ESCALATION_KIND, originSeq: 1, fromTier: 0, toTier: 1 })).toBe(true)
    expect(isMoaEscalationMessage({ kind: 'user' })).toBe(false)
    expect(isMoaEscalationMessage({ kind: MOA_ESCALATION_KIND, originSeq: 'x', fromTier: 0, toTier: 1 })).toBe(false)
    expect(isMoaEscalationMessage(undefined)).toBe(false)
    expect(isMoaEscalationMessage(null)).toBe(false)
  })
})
