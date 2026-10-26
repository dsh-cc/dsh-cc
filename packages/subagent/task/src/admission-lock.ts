/**
 * Per-parent admission lock for the spawn lanes (F-1, TLA `strict-cap-toctou`).
 *
 * The live-capacity guard reads the parent's running children across an
 * await and the creation call runs across another; with no lock, N concurrent
 * admissions at `live = cap - 1` all observed the same snapshot and all
 * created a child. The guard and the creation are now ONE critical section
 * per parent: a lease is taken before the check and released as soon as the
 * creation call has settled (child registered, or failed) — NOT when the
 * child's epoch ends, so foreground collects do not serialize their runs.
 *
 * FIFO per parent id; different parents never contend. A waiter whose signal
 * aborts leaves the queue immediately (it never consumes the slot and never
 * wedges those behind it). Leases are idempotent to release.
 *
 * @module @dsh-cc/subagent-task/admission-lock
 */

/** Release handle for a held admission; safe to call more than once. */
export type AdmissionLease = () => void

const tails = new Map<string, Promise<void>>()

/**
 * Acquire the admission lease for one parent session. Resolves when every
 * earlier lease of the same parent has been released.
 * @throws the signal's reason if it aborts while waiting.
 */
export async function acquireAdmission(parentId: string, signal: AbortSignal): Promise<AdmissionLease> {
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
  return tails.size
}
