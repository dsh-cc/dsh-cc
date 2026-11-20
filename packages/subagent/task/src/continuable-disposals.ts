/**
 * The root-realm `ccContinuableDisposals` service (design §3.4.4): a
 * parent-scoped registry of retained `SubagentActivation.dispose()` receipts.
 *
 * Harness rc.5 removed `drainChildren`; the upgrade guide's replacement is
 * "retain the activation returned by `startActivation()` and await its
 * `dispose()` to release that exact execution — an old activation cannot
 * release a later execution of the same Session". The CC composition's
 * tracked lanes (the Task tool's continuable background starts and the
 * coordinator's `spawn_worker`) therefore route through
 * {@link CcContinuableDisposals.startTracked}, which delegates to the seam
 * and retains a receipt bound to the CREATING parent's session id. The
 * release valve (`release_agent` / `/agents release`) then attempts exactly
 * one child's disposal by id through {@link CcContinuableDisposals.tryDispose}.
 *
 * @module @dsh-cc/subagent-task/continuable-disposals
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** The activation slice a receipt retains (harness `SubagentActivation`). */
export interface ContinuableActivationLike {
  /** Durable child session id (SessionId-branded at runtime). */
  readonly childId: string
  /**
   * Terminal outcome after teardown settles. For an idle-continuable child it
   * stays PENDING while the activation remains resident (harness
   * `watchLocalSettlement` closes only on the `ready` state), so settlement
   * of this promise is the receipt's natural-expiry signal.
   */
  readonly result: Promise<unknown>
  /** Stop and release only this activation; rejects on teardown failure. */
  dispose(): Promise<void>
}

/** The outcome of one {@link CcContinuableDisposals.tryDispose} attempt. */
export type ContinuableDisposalAttempt =
  /** A receipt for this parent+child pair is held; `disposed` is the (shared, memoized) dispose transaction — it REJECTS with the original teardown error. */
  | { readonly held: true; readonly disposed: Promise<void> }
  /** The child was never tracked by this process, OR its receipt was already dropped (natural settlement; a later `send_message` restores an activation no API can release by id). */
  | { readonly held: false; readonly cause: 'no-receipt' }
  /** A receipt exists but is bound to a different creating parent. */
  | { readonly held: false; readonly cause: 'foreign' }

/** The service face published on the root realm as `ccContinuableDisposals`. */
export interface CcContinuableDisposalsLike {
  startTracked<S extends { parent: { id: unknown } }, A extends ContinuableActivationLike>(
    seam: { startActivation(spec: S): Promise<A> },
    spec: S,
  ): Promise<A>
  tryDispose(parentId: SessionId, childId: SessionId): Promise<ContinuableDisposalAttempt>
}

/** One retained receipt: the activation plus its creating parent's id. */
interface ReceiptEntry {
  /** The creating parent's session id, captured at `startTracked` time. */
  readonly parentId: string
  readonly activation: ContinuableActivationLike
  /** The memoized in-flight dispose transaction, once a dispose was issued. */
  disposeMemo?: Promise<void>
}

/**
 * The receipt registry. Keyed by child session id; cleared on plugin unload
 * (the ccPlugins clear-on-unload idiom). Both lifecycle rules below are
 * identity-guarded, so an old cleanup can never remove a replacement entry.
 */
export class CcContinuableDisposals implements CcContinuableDisposalsLike {
  private readonly receipts = new Map<string, ReceiptEntry>()

  /**
   * Start a continuable child through the seam and retain its receipt,
   * parent-bound. Natural settlement (`activation.result` settling
   * terminally, resolve or reject) drops the receipt — UNLESS an in-flight
   * dispose memo exists for the same entry (harness `manager.ts` settles the
   * result before the close transaction propagates, so an unconditional
   * cleanup could delete the entry mid-dispose; when a memo exists, disposal
   * settlement owns the cleanup). A later `send_message` restore creates a
   * new activation this process holds no receipt for, so a release attempt
   * on it honestly returns `no-receipt`.
   */
  async startTracked<S extends { parent: { id: unknown } }, A extends ContinuableActivationLike>(
    seam: { startActivation(spec: S): Promise<A> },
    spec: S,
  ): Promise<A> {
    const activation = await seam.startActivation(spec)
    const key = String(activation.childId)
    const entry: ReceiptEntry = { parentId: String(spec.parent.id), activation }
    this.receipts.set(key, entry)
    const cleanup = (): void => {
      if (this.receipts.get(key) !== entry) return // identity guard
      if (entry.disposeMemo !== undefined) return // disposal settlement owns the cleanup
      this.receipts.delete(key)
    }
    void activation.result.then(cleanup, cleanup)
    return activation
  }

  /**
   * Release-attempt one child under one parent. Memoizes the in-flight
   * dispose promise per child — a concurrent retry gets the SAME
   * `{held: true, disposed}` pair (mirroring the harness's own `close()`
   * memoization). The entry is removed only after the dispose FULFILS; on
   * REJECTION (teardown failure) the entry remains and every retry returns
   * the same memoized rejecting promise — a teardown-failed child stays
   * honestly releasable-by-retry instead of degrading to a misleading
   * `no-receipt`. Never throws for `held: false`.
   */
  async tryDispose(parentId: SessionId, childId: SessionId): Promise<ContinuableDisposalAttempt> {
    const key = String(childId)
    const entry = this.receipts.get(key)
    if (entry === undefined) return { held: false, cause: 'no-receipt' }
    if (entry.parentId !== String(parentId)) return { held: false, cause: 'foreign' }
    if (entry.disposeMemo === undefined) {
      let memo: Promise<void>
      try {
        memo = entry.activation.dispose()
      } catch (error) {
        // A dispose that throws synchronously still becomes the memoized
        // rejecting transaction: the caller observes it through `disposed`.
        memo = Promise.reject(error)
      }
      entry.disposeMemo = memo
      void memo.then(
        () => {
          if (this.receipts.get(key) === entry) this.receipts.delete(key)
        },
        () => { /* rejection: the entry remains; retries return this memo */ },
      )
    }
    return { held: true, disposed: entry.disposeMemo }
  }

  /** Drop every receipt (plugin unload; test reset). Disposes nothing. */
  clear(): void {
    this.receipts.clear()
  }
}
