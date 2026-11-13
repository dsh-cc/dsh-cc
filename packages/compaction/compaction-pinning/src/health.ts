/**
 * In-process pinning health counters (design
 * docs/plans/2026-11-12-compaction-governed-pinning.md §Failure semantics):
 * `dropped`, `restored`, `evicted`, `captured` live in one process-wide record
 * and are exposed through {@link getPinningHealth} for TESTS only. There is no
 * user-facing notice, no ledger, and no durable record — the counters exist so
 * specs can assert the failure paths (drop on capture error, FIFO eviction, …)
 * that are otherwise invisible by design.
 *
 * Counters are module-level and per process (not per session): the rings
 * themselves are per session, so a test that needs a clean slate calls
 * {@link resetPinningHealth}.
 *
 * @module
 */

/** The pinning counters (§Failure semantics). */
export interface PinningHealth {
  /** Capture/store refusals and failures — the entry was NOT stored. */
  dropped: number
  /** Restores committed by the drain (the restore half owns this increment). */
  restored: number
  /** FIFO evictions performed on a per-session ring. */
  evicted: number
  /** Messages stored verbatim into a per-session ring. */
  captured: number
}

/** One counter name. */
export type PinningHealthKey = keyof PinningHealth

/** The live counters (module state; never exported by reference). */
const counters: PinningHealth = {
  dropped: 0,
  restored: 0,
  evicted: 0,
  captured: 0,
}

/**
 * Snapshot the counters. Returns a copy, so a caller can never mutate live
 * accounting.
 * @returns the current counter values.
 */
export function getPinningHealth(): PinningHealth {
  return { ...counters }
}

/**
 * Increment one counter. Never throws — every caller sits in a firehose or
 * cleanup path.
 * @param key - the counter to bump.
 * @param by - increment (defaults to one).
 */
export function bumpPinningHealth(key: PinningHealthKey, by = 1): void {
  counters[key] += by
}

/** Reset every counter to zero (test seam — the counters are process-wide). */
export function resetPinningHealth(): void {
  counters.dropped = 0
  counters.restored = 0
  counters.evicted = 0
  counters.captured = 0
}
