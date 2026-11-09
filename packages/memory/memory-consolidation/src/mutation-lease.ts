/**
 * The memory mutation lease: one FIFO write slot per canonical memory
 * directory (design
 * docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md §"The repo write
 * lease and its relation to dream").
 *
 * `off` mode keeps the legacy uncoordinated scheduling, so this lease is the
 * only mutual exclusion between shadow/active-mode extraction and dream inside
 * one plugin instance: extraction holds it from before the fork starts until
 * `job.done`, dream only tryAcquires it and returns without taking the original
 * disk lock when the slot is busy. It provides no cross-process transaction and
 * does not widen the meaning of the existing disk lock.
 *
 * Two properties matter for correctness:
 * - at most one owner per canonical dir, and the queue is strictly FIFO, so a
 *   long wait can never be overtaken by a newer request;
 * - a cancelled waiter is removed from the queue, so a cancelled gate cannot
 *   leave a phantom owner behind that would stall the next writer.
 *
 * The slot table is module scope, not per `apply()` call: every mount inside
 * this process serialises against the same table, which is strictly stronger
 * than the per-instance ownership the design asks for and is never visible
 * across processes.
 *
 * @module @dsh-cc/memory-consolidation/mutation-lease
 */

import { resolve } from 'node:path'

/** One queued acquire: its settlement handles plus its abort wiring. */
interface LeaseWaiter {
  /** Settle the acquire promise with the release handle. */
  readonly grant: (release: () => void) => void
  readonly signal: AbortSignal
  /** Removes this waiter from the queue and rejects its acquire promise. */
  readonly onAbort: () => void
  /** Set by whichever settlement path ran first; the loser is a no-op. */
  settled: boolean
}

/** Per-directory mutual exclusion slot: an owner flag plus its FIFO queue. */
interface LeaseSlot {
  owner: boolean
  readonly waiters: LeaseWaiter[]
}

/** Every slot in this process, keyed by the resolved directory spelling. */
const slots = new Map<string, LeaseSlot>()

/**
 * Canonicalise the key. Only the path spelling is normalised (`resolve` is
 * purely lexical, no fs access): directory identity itself — realpath, symlink
 * resolution and per-workspace isolation — stays owned by
 * `resolveWorkspaceMemoryDir()`.
 * @param dir - the canonical memory directory handed in by the caller.
 */
function slotKey(dir: string): string {
  return resolve(dir)
}

/**
 * The reason a cancelled wait rejects with. The caller's own abort reason is
 * preserved so a shared `AbortController` keeps one identity across a gate and
 * its lease wait; a bare signal gets a fresh, descriptive error.
 * @param signal - the aborted signal.
 */
function abortReason(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason
  return reason === undefined ? new Error('memory mutation lease wait cancelled') : reason
}

/**
 * Build the idempotent release handle for one grant: the first call frees the
 * slot and hands it to the oldest live waiter, every later call is a no-op.
 * @param key - the slot key this release belongs to.
 */
function createRelease(key: string): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    const slot = slots.get(key)
    if (slot === undefined) return
    slot.owner = false
    drain(key, slot)
  }
}

/**
 * Hand the freed slot to the oldest live waiter, or drop the slot when nobody
 * is waiting. A waiter cancelled between its last dequeue check and this grant
 * is skipped rather than granted.
 * @param key - the slot key being drained.
 * @param slot - the slot that was just released.
 */
function drain(key: string, slot: LeaseSlot): void {
  while (!slot.owner) {
    const waiter = slot.waiters.shift()
    if (waiter === undefined) {
      slots.delete(key)
      return
    }
    if (waiter.settled) continue
    waiter.settled = true
    waiter.signal.removeEventListener('abort', waiter.onAbort)
    slot.owner = true
    waiter.grant(createRelease(key))
  }
}

/**
 * Wait for the mutation lease of one canonical directory.
 *
 * Resolves with an idempotent release handle once this call owns the slot; the
 * queue is FIFO, so callers are granted in call order. An already-aborted
 * signal rejects immediately, and a wait cancelled through `signal` rejects
 * with the signal's reason and leaves no trace in the queue (design: "waiting
 * is cancelled by Agent/plugin disposal"). A caller that obtains a lease must
 * release it exactly once; obtaining two leases for the same work is forbidden.
 * @param dir - the canonical memory directory (see `resolveWorkspaceMemoryDir`).
 * @param signal - cancellation from Agent/plugin disposal or a scope change.
 * @returns the release handle for the granted lease.
 */
export function acquireMemoryMutationLease(dir: string, signal: AbortSignal): Promise<() => void> {
  const key = slotKey(dir)
  if (signal.aborted) return Promise.reject(abortReason(signal))
  const existing = slots.get(key)
  if (existing === undefined) {
    slots.set(key, { owner: true, waiters: [] })
    return Promise.resolve(createRelease(key))
  }
  // A free slot with an empty queue is granted right here: building a promise
  // the caller still has to await would gain nothing.
  if (!existing.owner && existing.waiters.length === 0) {
    existing.owner = true
    return Promise.resolve(createRelease(key))
  }
  return new Promise<() => void>((resolveLease, rejectLease) => {
    const waiter: LeaseWaiter = {
      grant: resolveLease,
      signal,
      settled: false,
      onAbort: () => {
        if (waiter.settled) return
        waiter.settled = true
        const index = existing.waiters.indexOf(waiter)
        if (index >= 0) existing.waiters.splice(index, 1)
        rejectLease(abortReason(signal))
      },
    }
    existing.waiters.push(waiter)
    signal.addEventListener('abort', waiter.onAbort, { once: true })
  })
}

/**
 * Take the mutation lease without waiting (the dream path).
 *
 * Returns the release handle when the slot is free, `undefined` when this
 * plugin already owns it or another writer is queued. The caller must not touch
 * the disk lock on `undefined`: that is exactly what keeps a dream round from
 * queueing behind the disk lock and misleading other processes.
 * @param dir - the canonical memory directory (see `resolveWorkspaceMemoryDir`).
 * @returns the release handle, or `undefined` when the slot is busy.
 */
export function tryAcquireMemoryMutationLease(dir: string): (() => void) | undefined {
  const key = slotKey(dir)
  const existing = slots.get(key)
  if (existing === undefined) {
    slots.set(key, { owner: true, waiters: [] })
    return createRelease(key)
  }
  // Never jump the queue: a queued waiter owns the next grant even in the
  // window where the slot is momentarily unowned.
  if (existing.owner || existing.waiters.length > 0) return undefined
  existing.owner = true
  return createRelease(key)
}
