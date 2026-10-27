/**
 * Per-parent FIFO admission shared by spawn and send_message dispatch.
 * Callers hold check + creation/acceptance under one lease and release in
 * finally. Approval runs before admission; there are no counters or expiring
 * reservations. Cancellation cannot free a held lease before creation settles.
 * Duplicate module copies share the queue through a process-global symbol.
 */
export type AdmissionLease = () => void
const STATE_KEY = Symbol.for('@dsh-cc/subagent-admission/v1')
const globals = globalThis as unknown as Record<symbol, { tails: Map<string, Promise<void>> } | undefined>
const state = globals[STATE_KEY] ??= { tails: new Map<string, Promise<void>>() }

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
