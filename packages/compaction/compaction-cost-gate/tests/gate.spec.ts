import { describe, expect, it } from 'vitest'
import { COLD_SHRINK_PRIOR, DEBT_AMORTIZE_REQUESTS } from '../src/types.ts'
import { evaluateGate } from '../src/gate.ts'

const BASE = {
  contextTokens: 10_000,
  streamRequestCount: 4,
  completedSteps: 2,
  pendingSteps: 3,
  rewriteDebt: [],
  margin: 1.0,
}

describe('gate arithmetic (§3.3)', () => {
  it('passes when projected savings strictly exceed margin × (rewrite + debt)', () => {
    // requestsPerStep = 4/2 = 2; saved = 10000×0.5×2×3 = 30000 > 1.0×10000
    const out = evaluateGate(BASE)
    expect(out.pass).toBe(true)
    expect(out.requestsPerStep).toBe(2)
    expect(out.projectedSavedInput).toBe(30_000)
    expect(out.shrink).toBe(COLD_SHRINK_PRIOR)
  })

  it('fails on the strict margin edge (equal is not enough)', () => {
    // requestsPerStep = 2; saved = 10000×0.5×2×1 = 10000 == margin×10000
    const out = evaluateGate({ ...BASE, pendingSteps: 1 })
    expect(out.pass).toBe(false)
    expect(out.projectedSavedInput).toBe(10_000)
  })

  it('never fires when pendingSteps === 0 (plan end has nothing to amortize over)', () => {
    const out = evaluateGate({ ...BASE, pendingSteps: 0 })
    expect(out.pass).toBe(false)
    expect(out.projectedSavedInput).toBe(0)
  })

  it('floors requestsPerStep at 1 (cold sessions)', () => {
    const out = evaluateGate({ ...BASE, streamRequestCount: 0, completedSteps: 0 })
    expect(out.requestsPerStep).toBe(1)
    // saved = 10000×0.5×1×3 = 15000 > 10000
    expect(out.pass).toBe(true)
  })

  it('uses the measured lastShrink instead of the cold prior', () => {
    const out = evaluateGate({ ...BASE, lastShrink: 0.2 })
    expect(out.shrink).toBe(0.2)
    expect(out.projectedSavedInput).toBe(10_000 * 0.2 * 2 * 3)
  })

  it('counts debt only inside the amortization window (exactly 5 requests retires it)', () => {
    const debt = [{ tokens: 10_000, requestsSince: DEBT_AMORTIZE_REQUESTS - 1 }]
    const out = evaluateGate({ ...BASE, rewriteDebt: debt })
    expect(out.debtTokens).toBe(10_000)
    // saved 30000 > 1.0×(10000+10000)
    expect(out.pass).toBe(true)

    const retired = [{ tokens: 10_000, requestsSince: DEBT_AMORTIZE_REQUESTS }]
    const out2 = evaluateGate({ ...BASE, rewriteDebt: retired })
    expect(out2.debtTokens).toBe(0)
  })

  it('fails when unamortized debt outweighs savings', () => {
    const debt = [{ tokens: 25_000, requestsSince: 0 }]
    const out = evaluateGate({ ...BASE, rewriteDebt: debt })
    expect(out.debtTokens).toBe(25_000)
    // 30000 <= 1.0×(10000+25000)
    expect(out.pass).toBe(false)
  })

  it('prices the comparison when a price row resolves (read vs write)', () => {
    // write 2× read 1: savedUsd = 30000×1/1e6, costUsd = 10000×2/1e6 → pass
    const priced = { cacheReadPerMTok: 1, cacheWritePerMTok: 2 }
    expect(evaluateGate({ ...BASE, price: priced }).pass).toBe(true)
    // write 10× read 1: 30000 < 100000 → fail
    const expensiveWrite = { cacheReadPerMTok: 1, cacheWritePerMTok: 10 }
    expect(evaluateGate({ ...BASE, price: expensiveWrite }).pass).toBe(false)
  })

  it('window-pressure override bypasses the margin comparison but keeps pendingSteps === 0 semantics', () => {
    // Would fail the margin; pressure bypasses it.
    expect(evaluateGate({ ...BASE, pendingSteps: 1, windowPressureTokens: 5_000 }).pass).toBe(true)
    // Plan end still never fires, even under pressure.
    expect(evaluateGate({ ...BASE, pendingSteps: 0, windowPressureTokens: 5_000 }).pass).toBe(false)
    // Below the threshold, normal gate applies.
    expect(evaluateGate({ ...BASE, windowPressureTokens: 20_000 }).pass).toBe(true)
  })
})
