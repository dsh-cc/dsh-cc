/**
 * Cordis plugin entry — what the preset's top-level `input-ledger` row mounts
 * (plan docs/plans/2026-11-12-per-step-input-ledger.md §"Package" and
 * §"Mounting singleton").
 *
 * The package publishes no Service, so the row carries no isolate key and the
 * plugin declares no `inject`. The whole behavior is the reference-counted
 * observer mount: a plain module with no `apply` never starts ("input-ledger:
 * never started" at preset composition).
 *
 * @module @dsh-cc/input-ledger/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import { mountInputLedger } from './mount.ts'

/** Cordis plugin id — the preset row id. */
export const name = 'input-ledger'

/**
 * Mount the three observers for the calling preset. The mount is
 * reference-counted on the ROOT context, so the cc + vwa double include of the
 * shared preset body registers ONE listener set; registering the returned
 * release handle as a fiber effect makes this preset's unload decrement the
 * count (the listeners go away with the last reference, never with a single
 * preset's unload).
 *
 * @param ctx - the preset context mounting this plugin.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => mountInputLedger(ctx), 'input-ledger: release observer mount')
}
