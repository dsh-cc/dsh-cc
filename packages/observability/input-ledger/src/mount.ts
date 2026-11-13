/**
 * The reference-counted, root-owned mount of the input ledger (plan
 * docs/plans/2026-11-12-per-step-input-ledger.md §"Mounting singleton").
 *
 * Cordis unregisters a preset's listeners when that preset unloads, so a naive
 * `WeakSet<rootCtx>` guard would permanently suppress observation after the
 * *owning* preset unloads while another preset remains mounted. The contract
 * here is therefore:
 *
 * - listeners are registered on the ROOT context (not the preset scope), at
 *   first mount, with a module-level `Map<rootCtx, { listenerCount, refs }>`;
 * - each preset mount increments `refs`, each unmount decrements, and listener
 *   disposal happens only when `refs → 0`;
 * - a second mount on the same root is a refs-only no-op (the cc + vwa
 *   double-include of `agent.shared.cordis.yml` is covered).
 *
 * The preset row (slice 3) is the intended caller; nothing here is wired into
 * a yml file yet.
 *
 * @module @dsh-cc/input-ledger/mount
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomeFn } from '@dsh-cc/sidecar-io'
import {
  createObservers,
  type GenerateOptionsLike,
  type PreStepPayloadLike,
} from './observe.ts'
import type { LedgerRow } from './rows.ts'
import { registerSettings, DEFAULT_INPUT_LEDGER_SETTINGS, readUserSettingsSync, type InputLedgerSettings } from './settings.ts'
import { appendLedgerRow, sessionLedgerPath } from './sink.ts'

/** One root context's registration: its listeners and its mount refcount. */
interface RootMount {
  listenerCount: number
  refs: number
  dispose(): void
}

/** One root context's mount, keyed by the root (never by a preset scope). */
const mounts = new Map<Context, RootMount>()

/** Test seam: replace the hot settings read, row sink, or process boot id. */
export interface MountOverrides {
  readSettings?: () => InputLedgerSettings
  emit?: (row: LedgerRow, projectKey: string, settings: InputLedgerSettings) => void
  gen?: string
}

/** The root context of a mount call (a bare test context may be its own root). */
function rootOf(ctx: Context): Context {
  const root = (ctx as { readonly root?: Context }).root
  return root === undefined ? ctx : root
}

/** Guarded dsh-home root read: the resolver and its call may both throw on a bare host. */
function dshHomeOf(root: Context): string | undefined {
  try {
    const resolve = dshHomeFn(root)
    return resolve === undefined ? undefined : resolve()
  } catch {
    return undefined
  }
}

/** Debug sink wrapper: cordis throws on the access itself when the service is absent. */
function debugOf(root: Context, message: string): void {
  try {
    root.logger.debug(message)
  } catch {
    // Debug sink failures are swallowed by contract.
  }
}

/** Release handle: the first call decrements `refs`; repeats are inert. */
function releaseOf(root: Context): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    const entry = mounts.get(root)
    if (entry === undefined) return
    entry.refs -= 1
    if (entry.refs > 0) return
    mounts.delete(root)
    entry.dispose()
  }
}

/**
 * Mount the three observers on the root context of `ctx`.
 *
 * Idempotent per root: the first call registers the listeners, every further
 * call only increments the reference count. The returned disposer decrements
 * it and tears the listeners down when the last reference goes away.
 *
 * @param ctx - the preset (or any) context asking for observation.
 * @param overrides - test seam; production callers pass nothing.
 * @returns the release handle for this mount.
 */
export function mountInputLedger(ctx: Context, overrides: MountOverrides = {}): () => void {
  const root = rootOf(ctx)
  const existing = mounts.get(root)
  if (existing !== undefined) {
    existing.refs += 1
    return releaseOf(root)
  }
  mounts.set(root, startMount(root, overrides))
  return releaseOf(root)
}

/** Register the listeners on one root and build its mount record. */
function startMount(root: Context, overrides: MountOverrides): RootMount {
  const home = dshHomeOf(root)
  try {
    registerSettings(root)
  } catch (error) {
    debugOf(root, `input-ledger: settings namespace registration failed: ${describe(error)}`)
  }
  const observers = createObservers({
    readSettings: overrides.readSettings
      ?? (() => (home === undefined ? DEFAULT_INPUT_LEDGER_SETTINGS : readUserSettingsSync(home))),
    emit: overrides.emit
      ?? ((row, projectKey, settings) => writeRow(home, row, projectKey, settings)),
    debug: message => debugOf(root, message),
    gen: overrides.gen ?? randomUUID(),
  })
  const disposers: Array<() => unknown> = [
    // Observer A: no prepend — runs inside every prepended rewriter, so it sees
    // the innermost-final view at its position.
    listen(root, 'system-prompt/assemble', observers.assemble as never, undefined),
    // Observer B: global + prepend; synchronous computation before next().
    listen(
      root,
      'llm/stream',
      ((options: GenerateOptionsLike, next: () => unknown) => observers.request(options, next)) as never,
      { global: true, prepend: true },
    ),
    // Observer C: delegate-first attribution; the payload is returned untouched.
    listen(
      root,
      'agent/pre-step',
      ((payload: PreStepPayloadLike, next: () => Promise<unknown>) => observers.preStep(payload, next)) as never,
      { prepend: true },
    ),
  ]
  const listenerCount = disposers.length
  debugOf(root, `input-ledger: mounted ${listenerCount} listeners`)
  return {
    listenerCount,
    refs: 1,
    dispose: () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (error) {
          debugOf(root, `input-ledger: listener disposal failed: ${describe(error)}`)
        }
      }
    },
  }
}

/** Register one listener on the root, cast through the untyped event surface. */
function listen(
  root: Context,
  event: string,
  listener: never,
  options: { prepend?: boolean; global?: boolean } | undefined,
): () => unknown {
  const on = root.on as unknown as (
    name: string,
    handler: unknown,
    options?: { prepend?: boolean; global?: boolean },
  ) => () => unknown
  return on.call(root, event, listener, options)
}

/**
 * Store one row through the shared sink. The append is detached and never
 * rejects; a missing dshHome is a no-op (files are never deleted).
 */
function writeRow(
  home: string | undefined,
  row: LedgerRow,
  projectKey: string,
  settings: InputLedgerSettings,
): void {
  if (home === undefined) return
  const file = sessionLedgerPath(home, projectKey, row.sessionId)
  void appendLedgerRow(file, row, undefined, settings['max-rows-per-file']).catch(() => {
    // appendLedgerRow resolves on every path by contract; belt-and-braces only.
  })
}

/** Best-effort one-line description of a caught failure. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The observers currently registered for one root (introspection for tests). */
export function mountStateOf(ctx: Context): { listenerCount: number; refs: number } | undefined {
  const entry = mounts.get(rootOf(ctx))
  return entry === undefined ? undefined : { listenerCount: entry.listenerCount, refs: entry.refs }
}
