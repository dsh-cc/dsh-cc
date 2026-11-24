/**
 * The dream lane's bounded FIFO wait on the mutation lease
 * (specs/tla/dream-lease-wait, the 2026-11-23 starvation fix).
 *
 * In `shadow`/`active` extraction mode the coordinator holds the per-plugin
 * mutation lease for a whole fork job, and the dream's old `tryAcquire`
 * balked — so dream structurally never won the slot while extraction was
 * active (0 dispatches across 2.5h of live attempts; dispatch within 20s
 * with extraction off). This module replaces the balk with a bounded FIFO
 * queue: the lease's own `drain()` hands a released slot to the OLDEST live
 * waiter, so a queued dream is granted before any extraction attempt that
 * queued after it.
 *
 * The disk-lock rationale is untouched: the dream still takes the
 * cross-process `.consolidation-lock` only while already holding the local
 * lease, never queues behind it.
 *
 * Cancellation: the fiber teardown sets `cell.cancelled` and aborts the live
 * wait handle (BEFORE `coordinator.dispose()` — dispose releases the
 * extraction owner, and the drain would otherwise grant the dream first and
 * make the abort a no-op). Two races are closed by checking the cell AFTER
 * the acquire too: a disposal during the pre-lease fs awaits, and a
 * grant-then-teardown interleave (drain settles synchronously; the await
 * continuation is a microtask). A granted-but-cancelled lease is released
 * immediately, never dispatched on.
 * @module @dsh-cc/memory-consolidation/acquire-dream-lease
 */

import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { MemoryMutationLease } from './mutation-lease.ts'

// Re-exported for index.ts's apply-layer validation (one import line there).
export { MAX_TIMER_DELAY_MS }

/** The abort reason the wait timer stamps (distinct from fiber disposal). */
const LEASE_TIMEOUT_REASON = 'lease-timeout'
/** The abort reason the fiber teardown stamps. */
const DISPOSE_REASON = 'dispose'

/**
 * The knob's validated schema (schemastery). The inner `z.number().min(0)
 * .max(MAX_TIMER_DELAY_MS)` does NOT catch `NaN` (`NaN > max` and `NaN <
 * min` are both false — runtime-probed), so the transform callback's
 * `Number.isFinite` is load-bearing. `.default(600_000)` sits on the OUTER
 * transform: probed, an omitted key resolves to the default while an
 * inner-only `.default` does not.
 */
export const DreamLeaseWaitSchema = z.transform(
  z.number().min(0).max(MAX_TIMER_DELAY_MS),
  (n) => {
    if (!Number.isFinite(n)) throw new Error('dreamLeaseWaitMs must be a finite number')
    return n
  },
).default(600_000)

/** The default bound (10 min): one extraction fork job; the cap on how long a hung extraction can wedge `dreamInFlight`. */
export const DEFAULT_DREAM_LEASE_WAIT_MS = 600_000

/**
 * The dream's mutable cancellation cell, allocated in `apply()`'s closure
 * (the fiber effect lives there; a module-level cell would leak across
 * mounts). `wait` is the live abort handle of the current queued attempt.
 */
export interface DreamWaitCell {
  /** Set by the fiber teardown; checked before AND after the acquire. */
  cancelled: boolean
  /** The live wait handle while a dream attempt is queued. */
  wait: { abort: () => void } | undefined
}

/** The discriminated acquire outcome (the old `undefined` conflated three). */
export type DreamLeaseResult =
  | { status: 'granted'; release: () => void }
  /** `waitMs <= 0` and contended: the documented balk escape hatch. */
  | { status: 'balked' }
  /** The wait timer fired (breadcrumb `lease-timeout`). */
  | { status: 'timeout' }
  /** Fiber disposal cancelled the wait (no lease-timeout breadcrumb). */
  | { status: 'aborted' }

/**
 * Acquire the mutation lease for a dream round: fast path first, then a
 * bounded FIFO wait.
 *
 * A RESOLVED acquire is granted unconditionally — promise settlement
 * decides, not `signal.aborted`: `drain()` removes the abort listener
 * synchronously on grant, so a timer firing between the settle and the
 * await continuation hits the lease's `settled` guard (a no-op) and the
 * signal can be aborted with a grant in hand. `signal.reason` is read only
 * in the rejection branch. Unexpected rejections propagate to the caller's
 * `dream dispatch failed` warn path (never swallowed).
 * @param lease - the plugin's mutation lease table.
 * @param dir - the canonical memory directory.
 * @param waitMs - the wait bound (`0` restores the pre-fix balk).
 * @param cell - the mount-scoped cancellation cell (mutated by teardown).
 * @param log - the debug-event seam; the `queued` event fires synchronously
 * after the waiter is pushed and BEFORE the await.
 * @returns the discriminated outcome.
 */
export async function acquireDreamLease(
  lease: MemoryMutationLease,
  dir: string,
  waitMs: number,
  cell: DreamWaitCell,
  log: (event: string, fields: Record<string, unknown>) => void,
): Promise<DreamLeaseResult> {
  const immediate = lease.tryAcquire(dir)
  if (immediate !== undefined) return { status: 'granted', release: immediate }
  if (waitMs <= 0) return { status: 'balked' }
  const controller = new AbortController()
  cell.wait = { abort: () => controller.abort(DISPOSE_REASON) }
  // .unref(): a CLI finishing its turn is not held open by the wait.
  const timer = setTimeout(() => controller.abort(LEASE_TIMEOUT_REASON), waitMs)
  timer.unref?.()
  // The lease pushes the waiter synchronously inside the promise executor,
  // so this log lands after registration and before the await — the
  // deterministic "dream is queued" observation.
  const acquired = lease.acquire(dir, controller.signal)
  log('memory:dream-lease', { queued: 1 })
  try {
    const release = await acquired
    return { status: 'granted', release }
  } catch (err) {
    if (controller.signal.aborted) {
      return controller.signal.reason === LEASE_TIMEOUT_REASON
        ? { status: 'timeout' }
        : { status: 'aborted' }
    }
    throw err
  } finally {
    clearTimeout(timer)
    if (cell.wait !== undefined && cell.wait.abort !== undefined) cell.wait = undefined
  }
}

/**
 * The dream's full lease stage: pre-check, bounded acquire, timeout
 * breadcrumb, post-grant cancellation release — everything between the
 * dream's gates and the disk lock. Returns the release handle plus the
 * fresh acquisition timestamp for the disk-lock identity, or `undefined`
 * when this round is over (balked, timed out, aborted, or cancelled).
 *
 * Quiesce note (mode flip while queued): `quiesce()` releases the
 * extraction owner unconditionally, so the drain can grant the queued
 * dream even while the old extraction's write-back is still settling —
 * bounded by the write-back's optimistic commit (mergeIndexContent
 * absorbs concurrent additions; both writers are host-validated).
 */
export async function settleDreamLease(
  lease: MemoryMutationLease,
  dir: string,
  waitMs: number,
  cell: DreamWaitCell,
  reportTimeout: (detail: string) => Promise<void>,
  log: (event: string, fields: Record<string, unknown>) => void,
): Promise<{ release: () => void; acquiredAt: number } | undefined> {
  // A disposal during the pre-lease fs awaits must not register a waiter.
  if (cell.cancelled) return undefined
  const result = await acquireDreamLease(lease, dir, waitMs, cell, log)
  if (result.status === 'timeout') {
    // The only dream failure that was previously invisible. The pressure
    // marker was stamped BEFORE the wait, so the next cooldown window (or
    // the periodic gate) retries. The report write targets a different
    // file than the write-back and sits outside the lease's scope.
    await reportTimeout(
      `local lease wait expired after ${waitMs}ms; the pressure marker stays armed and the next window retries`,
    )
    log('memory:dream-lease', { timeout: 1 })
    return undefined
  }
  if (result.status !== 'granted') return undefined
  // A disposal that raced the grant (drain settles synchronously; the await
  // continuation is a microtask): the granted lease is released, never
  // dispatched on.
  if (cell.cancelled) {
    result.release()
    return undefined
  }
  // A fresh acquisition timestamp: the entry timestamp predates a possibly
  // minutes-long queue wait, and the disk lock must not be born already
  // aged (releaseLock/rollbackLock read-verify `format(pid, at)` — a stale
  // timestamp silently no-ops and strands the lock).
  return { release: result.release, acquiredAt: Date.now() }
}
