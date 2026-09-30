/**
 * Internal registration records and the commit/event fan-out machinery of the
 * settings seam.
 *
 * Vendored verbatim from harness `@deepseek-ai/dsh-settings` at pin
 * `1ef9c1fa9a` (0.1.5-rc.1), `packages/settings/settings/src/index.ts`
 * (`SettingsWatcher`/`SettingsRegistration` and the private commit,
 * revision-bump, and event fan-out helpers, lifted from the class body into
 * module functions so the provider file stays under the 500-line gate; the
 * semantics are unchanged).
 *
 * @module @dsh-cc/settings-provider/events
 */

import type z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type { SettingsApplies } from './contract.ts'
import type { SettingsNamespace, SettingsUpdateSource } from './types.ts'

/** One registered watcher and its serialized invocation chain. */
export interface SettingsWatcher {
  callback: (next: never, prev: never) => void | Promise<void>
  /** Settled tail: invocations of this callback run one at a time, in commit order. */
  tail: Promise<void>
  /** Cleared by the disposer: a queued invocation checks this before starting. */
  active: boolean
}

/** One live namespace registration owned by a registrant fiber. */
export interface SettingsRegistration {
  ns: SettingsNamespace
  schema: z<unknown>
  base: unknown
  applies: SettingsApplies
  /** Owner-supplied check for constraints the schema cannot express. */
  validate?: (value: unknown) => void
  resolved: unknown
  /**
   * Monotonic counter over this namespace's RAW user section — bumped by any
   * change to what is stored, including one whose resolved value is
   * unchanged (adding an override equal to the composition base). Editors
   * carry it as `expectedRevision` to detect a concurrent write, and the
   * document event carries it so another tab learns a field went from
   * inherited to overridden.
   */
  revision: number
  watchers: Set<SettingsWatcher>
}

/**
 * Services the commit machinery needs from the owning provider instance.
 * Mirrors the private members the original class methods closed over.
 */
export interface CommitDeps {
  ctx: Context
  /** Opaque read of the provider's stopped flag. */
  isStopped(): boolean
  /** In-flight watcher invocation segments, drained by the dispose teardown. */
  pendingTails: Set<Promise<void>>
}

/**
 * Advance a namespace's revision when its RAW section changed, and announce
 * it. Deliberately independent of {@link commit}'s resolved-value equality:
 * storing an override equal to the composition base leaves the resolved
 * value alone but changes what the document says, which is exactly what a
 * configuration surface must re-read.
 */
export function bumpRevision(deps: CommitDeps, registration: SettingsRegistration, before: unknown, after: unknown): void {
  if (deepEqualJson(before, after)) return
  registration.revision += 1
  emitDocumentUpdated(deps, registration.ns, registration.revision)
}

/** Contained fan-out of `settings/document-updated`, mirroring {@link commit}'s. */
function emitDocumentUpdated(deps: CommitDeps, ns: SettingsNamespace, revision: number): void {
  let invariantFailure: unknown
  const args = ['settings/document-updated', ns, revision]
  for (const listener of deps.ctx.events.dispatch('emit', args) as Array<(...listenerArgs: unknown[]) => unknown>) {
    try {
      const returned = listener(ns, revision)
      if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
          warnListenerFailure(deps, ns, error)
        })
      }
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
        invariantFailure ??= error
        continue
      }
      warnListenerFailure(deps, ns, error)
    }
  }
  if (invariantFailure !== undefined) throw invariantFailure as Error
}

/** Commit a resolved value when changed: swap, notify watchers, emit the event. */
export function commit(deps: CommitDeps, registration: SettingsRegistration, next: unknown, source: SettingsUpdateSource): void {
  const prev = registration.resolved
  if (deepEqualJson(next, prev)) return
  registration.resolved = next
  for (const watcher of [...registration.watchers]) {
    // Serialize per watcher: invocations of one callback run one at a time
    // in commit order, so a slow stale invocation can never apply after a
    // newer one. Sync throws and async rejections land in the same handler.
    // The activity check runs when the queued invocation would start, so a
    // disposer (or service stop) that ran while it waited prevents the
    // start entirely; started invocations drain at service dispose.
    const segment = watcher.tail
      .then(() => {
        if (!watcher.active || deps.isStopped()) return
        return watcher.callback(next as never, prev as never)
      })
      .then(() => undefined, (error: unknown) => {
        warnWatcherFailure(deps, registration.ns, error)
      })
    watcher.tail = segment
    deps.pendingTails.add(segment)
    void segment.then(() => deps.pendingTails.delete(segment))
  }
  // Fan the event out one listener at a time (the plain emit stops at the
  // first throwing listener, starving the rest). Invariant violations are
  // harness-fatal by design and rethrow after every listener ran; any other
  // failure is contained so one broken observer cannot wedge the commit
  // path (and, through it, a provider's reload loop).
  let invariantFailure: unknown
  const args = ['settings/updated', registration.ns, next, prev, source]
  for (const listener of deps.ctx.events.dispatch('emit', args) as Array<(...listenerArgs: unknown[]) => unknown>) {
    try {
      const returned = listener(registration.ns, next, prev, source)
      if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
        // An emit listener may still be an async function; its rejection
        // cannot reach the synchronous INVARIANT rethrow below, so it is
        // contained here instead of becoming an unhandled rejection.
        void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
          warnListenerFailure(deps, registration.ns, error)
        })
      }
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
        invariantFailure ??= error
        continue
      }
      warnListenerFailure(deps, registration.ns, error)
    }
  }
  if (invariantFailure !== undefined) throw invariantFailure as Error
}

/** Contained-watcher diagnostic shared by the sync and async failure paths. */
function warnWatcherFailure(deps: CommitDeps, ns: SettingsNamespace, error: unknown): void {
  deps.ctx.logger.warn('settings: watcher for "%s" failed', ns)
  deps.ctx.logger.warn(error)
}

/** Contained-listener diagnostic shared by the sync and async failure paths. */
function warnListenerFailure(deps: CommitDeps, ns: SettingsNamespace, error: unknown): void {
  deps.ctx.logger.warn('settings: a settings/updated listener for "%s" failed', ns)
  deps.ctx.logger.warn(error)
}
