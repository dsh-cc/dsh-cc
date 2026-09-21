/**
 * Pure cost-gate arithmetic (design §3.3): compare projected input-token
 * savings over the remaining plan against the prompt-cache rewrite price plus
 * unamortized rewrite debt. No I/O, no clock, no services — a table-testable
 * fold over measured inputs.
 * @module @dsh-cc/compaction-cost-gate/gate
 */

import {
  COLD_SHRINK_PRIOR,
  DEBT_AMORTIZE_REQUESTS,
  type GateInput,
  type GateOutcome,
} from './types.ts'

/**
 * Evaluate the gate for one idle boundary.
 * @param input - measured gate inputs (§3.3.1–3.3.7).
 * @returns the outcome with every intermediate term for the ledger.
 */
export function evaluateGate(input: GateInput): GateOutcome {
  const requestsPerStep = Math.max(
    input.streamRequestCount / Math.max(input.completedSteps, 1),
    1,
  )
  const shrink = input.lastShrink ?? COLD_SHRINK_PRIOR
  let debtTokens = 0
  for (const entry of input.rewriteDebt) {
    if (entry.requestsSince < DEBT_AMORTIZE_REQUESTS) debtTokens += entry.tokens
  }
  const rewriteCost = input.contextTokens + debtTokens
  const pendingSteps = input.pendingSteps
  // Plan end is a natural session tail: no future requests to amortize over.
  const projectedSavedInput = pendingSteps === 0
    ? 0
    : input.contextTokens * shrink * requestsPerStep * pendingSteps
  const windowPressureOverride =
    input.windowPressureTokens !== undefined
    && input.contextTokens >= input.windowPressureTokens
    && pendingSteps > 0
  let pass: boolean
  if (pendingSteps === 0) {
    pass = false
  } else if (windowPressureOverride) {
    pass = true
  } else if (input.price !== undefined) {
    // Savings price at the cache-read rate, rewrite at the cache-write rate.
    // Without a price row the comparison stays in tokens (conservative:
    // cache writes price above reads).
    const savedUsd = projectedSavedInput * input.price.cacheReadPerMTok
    const costUsd = rewriteCost * input.price.cacheWritePerMTok
    pass = savedUsd > input.margin * costUsd
  } else {
    pass = projectedSavedInput > input.margin * rewriteCost
  }
  return {
    pass,
    pendingSteps,
    requestsPerStep,
    shrink,
    projectedSavedInput,
    rewriteCost,
    debtTokens,
    windowPressureOverride,
  }
}
