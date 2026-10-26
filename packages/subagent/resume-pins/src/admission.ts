/**
 * Per-parent admission shared by every path that can occupy one of a parent's
 * 25 live-child slots: the three spawn lanes in `@dsh-cc/subagent-task` and a
 * `send_message` continuation of a settled child (this package's resume gate).
 * It lives here — the dependency root both sides already share — so neither
 * package imports the other.
 *
 * Two pieces, one critical section per parent:
 *
 * - **Lease** ({@link acquireAdmission}): FIFO mutex around "count live
 *   children, then occupy a slot". Spawn holds it across the creation call
 *   (the child is registered when it settles). A waiter whose signal aborts
 *   leaves the queue and never receives the lease, even when the abort lands
 *   after its predecessor released.
 * - **Reservation** ({@link reserveContinuationSlot}): a continuation cannot
 *   hold the lease until its activation — the tool body runs after the whole
 *   `tools/pre-execute` waterfall (which may block on a user approval), so a
 *   held lease would starve every spawn for that long. Instead the continuation
 *   takes the lease only for check + reserve, and the slot stays reserved until
 *   the activation is visible as running, the tool settles (post-execute),
 *   its signal aborts, the call is denied, or a safety TTL expires. Both guards
 *   count live + outstanding reservations, so neither can over-admit.
 *
 * State is process-global (keyed by `Symbol.for`) so duplicate copies of this
 * module in one process still share one queue.
 *
 * @module @dsh-cc/subagent-resume-pins/admission
 */

/** Release handle for a held lease or reservation; safe to call more than once. */
export type AdmissionLease = () => void

/** Safety bound for an outstanding continuation reservation. */
export const CONTINUATION_RESERVATION_TTL_MS = 30_000

interface Reservation { readonly childId: string }

interface AdmissionState {
  readonly tails: Map<string, Promise<void>>
  readonly reservations: Map<string, Set<Reservation>>
}

const STATE_KEY = Symbol.for('@dsh-cc/subagent-admission/v1')
const globals = globalThis as unknown as Record<symbol, AdmissionState | undefined>
const state: AdmissionState = globals[STATE_KEY] ??= { tails: new Map(), reservations: new Map() }

/**
 * Acquire the admission lease for one parent session. Resolves when every
 * earlier lease of the same parent has been released.
 * @throws the signal's reason if it aborts while waiting, or before the lease
 *   would be handed over (a cancelled waiter never holds the lease).
 */
export async function acquireAdmission(parentId: string, signal: AbortSignal): Promise<AdmissionLease> {
  const { tails } = state
  signal.throwIfAborted()
  const previous = tails.get(parentId) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>(resolve => { release = resolve })
  const tail = previous.then(() => mine)
  tails.set(parentId, tail)
  const cleanup = (): void => {
    if (tails.get(parentId) === tail) tails.delete(parentId)
  }
  let abortWaiter: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    abortWaiter = () => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', abortWaiter, { once: true })
  })
  try {
    await Promise.race([previous, aborted])
    // The race can settle with the predecessor and the abort land before this
    // continuation runs: recheck so a cancelled waiter is never handed the lease.
    signal.throwIfAborted()
  } catch (error) {
    // Left the queue without holding the lease: pass the turn straight on.
    release()
    void tail.then(cleanup)
    throw error
  } finally {
    if (abortWaiter !== undefined) signal.removeEventListener('abort', abortWaiter)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    release()
    void tail.then(cleanup)
  }
}

/** Test/diagnostic hook: number of parents with a held or queued admission. */
export function admissionQueueSize(): number {
  return state.tails.size
}

/**
 * Reserve one slot for a continuation that has passed its capacity check but
 * whose activation is not yet visible. Call under the admission lease.
 * @param childId - the ended child being continued.
 * @returns an idempotent release; also fired by a safety TTL.
 */
export function reserveContinuationSlot(
  parentId: string,
  childId: string,
  ttlMs: number = CONTINUATION_RESERVATION_TTL_MS,
): AdmissionLease {
  const reservation: Reservation = { childId }
  let set = state.reservations.get(parentId)
  if (set === undefined) state.reservations.set(parentId, set = new Set())
  set.add(reservation)
  let released = false
  const timer = setTimeout(() => release(), ttlMs)
  timer.unref?.()
  function release(): void {
    if (released) return
    released = true
    clearTimeout(timer)
    const current = state.reservations.get(parentId)
    current?.delete(reservation)
    if (current?.size === 0) state.reservations.delete(parentId)
  }
  return release
}

/**
 * Outstanding continuation reservations for a parent that do not yet hold a
 * visible slot. A reservation whose child already reports running is counted
 * by the live-child count, so it is skipped here (no double count).
 */
export function pendingContinuations(parentId: string, isRunning: (childId: string) => boolean): number {
  let pending = 0
  for (const reservation of state.reservations.get(parentId) ?? []) {
    if (!isRunning(reservation.childId)) pending += 1
  }
  return pending
}
