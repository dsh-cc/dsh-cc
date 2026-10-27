/**
 * Review P2 on #301: after `Promise.race([previous, aborted])` settles with the
 * predecessor, the signal was never rechecked, so a waiter cancelled in the
 * window between the predecessor's release and the waiter's resumption still
 * received a lease with `signal.aborted === true`. Every interleaving of the
 * abort relative to the release must either reject or return a live lease.
 */
import { describe, expect, it } from 'vitest'
import { acquireAdmission, admissionQueueSize } from '../src/admission.ts'

/** A signal whose abort the test fires at an exact microtask offset, recording its state at hand-over. */
function steppedSignal() {
  let listener: (() => void) | undefined
  const sig = {
    aborted: false,
    reason: undefined as unknown,
    atHandover: undefined as boolean | undefined,
    throwIfAborted() { if (this.aborted) throw this.reason },
    addEventListener(_type: string, fn: () => void) { listener = fn },
    // The queue detaches its listener immediately before returning the lease (or throwing).
    removeEventListener() { this.atHandover = this.aborted },
    abort() { this.aborted = true; this.reason = new Error('cancelled'); listener?.() },
  }
  return sig
}

describe('review P2: a cancelled waiter never receives a lease', () => {
  it('abort after the predecessor released, at every microtask offset: reject, or a lease handed over un-aborted', async () => {
    const handedOver: { hops: number; aborted: boolean }[] = []
    for (let hops = 0; hops < 12; hops++) {
      const holder = await acquireAdmission(`p2-${hops}`, new AbortController().signal)
      const signal = steppedSignal()
      const waiter = acquireAdmission(`p2-${hops}`, signal as unknown as AbortSignal).then(
        lease => lease,
        () => undefined,
      )
      holder()
      let chain: Promise<void> = Promise.resolve()
      for (let i = 0; i < hops; i++) chain = chain.then(() => undefined)
      void chain.then(() => signal.abort())
      const lease = await waiter
      if (lease !== undefined) {
        handedOver.push({ hops, aborted: signal.atHandover === true })
        lease()
      }
    }
    // Every lease that WAS handed over must have been handed over un-aborted.
    expect(handedOver.filter(h => h.aborted)).toEqual([])
    // Sanity: the sweep really covers both outcomes (early aborts reject, late ones win the lease).
    expect(handedOver.length).toBeGreaterThan(0)
    expect(handedOver.length).toBeLessThan(12)
    await Promise.resolve()
    await Promise.resolve()
    expect(admissionQueueSize()).toBe(0)
  })

  it('a cancelled waiter that rejected hands the turn on without wedging the queue', async () => {
    const holder = await acquireAdmission('p2-wedge', new AbortController().signal)
    const controller = new AbortController()
    const cancelled = acquireAdmission('p2-wedge', controller.signal)
    const next = acquireAdmission('p2-wedge', new AbortController().signal)
    holder()
    controller.abort()
    await cancelled.then(lease => lease(), () => undefined)
    const lease = await next
    lease()
  })
})
