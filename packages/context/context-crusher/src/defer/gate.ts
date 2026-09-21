/**
 * Pure suffix-cost gate for the deferred swap (design §3.4). No I/O, no
 * clock, no services — a table-testable fold over measured inputs.
 *
 * Prompt cache is a prefix: replacing the message at index k busts cache from
 * k to the surface end, so the swap's rewrite price is the suffix measured AT
 * SWAP TIME, not the stored prefix. With no price table resolved the
 * comparison stays in token units — conservative in the direction of NOT
 * swapping, the safe side.
 *
 * @module @dsh-cc/context-crusher/defer/gate
 */

export interface DeferGateInput {
  /** tokensBefore − tokensAfter, recorded when the resident was stored. */
  readonly tokensSaved: number
  /** Observed requests-per-step × pending todo steps; floored at 1 here too. */
  readonly remainingRequestsEstimate: number
  /** `defer-margin` multiplier over the suffix cost. */
  readonly margin: number
  /** Σ estimateMessage over surface nodes after the entry, at swap time. */
  readonly suffixTokens: number
  /** `defer-urgency-tokens` window-pressure distance; unset = inactive. */
  readonly urgencyTokens?: number
  /** Current session token estimate, when a meter is available. */
  readonly sessionTokens?: number
  /** Routed model context window, when a window source advertised one. */
  readonly contextWindow?: number
}

export interface DeferGateOutcome {
  readonly pass: boolean
  readonly projectedSavings: number
  readonly suffixCost: number
  readonly urgencyOverride: boolean
}

/**
 * Evaluate the swap gate for one eligible resident entry.
 * @param input - measured gate inputs (suffix measured at swap time).
 * @returns the decision with every intermediate term for the ledger.
 */
export function evaluateDeferGate(input: DeferGateInput): DeferGateOutcome {
  const projectedSavings = input.tokensSaved * Math.max(1, input.remainingRequestsEstimate)
  const suffixCost = input.margin * input.suffixTokens
  const urgencyOverride = input.urgencyTokens !== undefined
    && input.sessionTokens !== undefined
    && input.contextWindow !== undefined
    && input.sessionTokens >= input.contextWindow - input.urgencyTokens
  return {
    pass: urgencyOverride || projectedSavings > suffixCost,
    projectedSavings,
    suffixCost,
    urgencyOverride,
  }
}
