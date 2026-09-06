/**
 * The three dream gates: time, session count, and lock. Combinable pure
 * predicates over inputs a caller reads from the seam, plus a composite check.
 * @module @dsh-cc/memory-consolidation/gates
 */

/** Inputs to the time and session gates. */
export interface ConsolidationGateInput {
  /** Epoch of the last consolidation (0 when none / absent lock). */
  lastConsolidatedAt: number
  /** Current epoch. */
  now: number
  /** Minimum hours since the last consolidation. */
  minHours: number
  /** Number of transcripts touched since the last consolidation. */
  sessionCount: number
  /** Minimum transcripts to review. */
  minSessions: number
}

/**
 * Time gate: at least `minHours` since the last consolidation.
 * @param lastConsolidatedAt - last consolidated epoch (0 opens the gate).
 * @param now - current epoch.
 * @param minHours - minimum elapsed hours.
 * @returns whether the time gate passes.
 */
export function timeGatePasses(lastConsolidatedAt: number, now: number, minHours: number): boolean {
  // A zero last-consolidation means none ever happened: open the gate.
  if (lastConsolidatedAt <= 0) return true
  return now - lastConsolidatedAt >= minHours * 3_600_000
}

/**
 * Session gate: at least `minSessions` transcripts touched since the last
 * consolidation.
 * @param sessionCount - transcripts touched since the last consolidation.
 * @param minSessions - minimum transcripts to review.
 * @returns whether the session gate passes.
 */
export function sessionGatePasses(sessionCount: number, minSessions: number): boolean {
  return sessionCount >= minSessions
}

/**
 * Composite check: the time and session gates together. The lock gate is a
 * separate acquisition step (see {@link tryAcquireLock}).
 * @param input - gate inputs.
 * @returns whether both the time and session gates pass.
 */
export function gatesPass(input: ConsolidationGateInput): boolean {
  return timeGatePasses(input.lastConsolidatedAt, input.now, input.minHours)
    && sessionGatePasses(input.sessionCount, input.minSessions)
}
