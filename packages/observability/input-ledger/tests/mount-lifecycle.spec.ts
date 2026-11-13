/**
 * Real boot: one row per request, and the reference-counted mount lifecycle
 * (design §"Mounting singleton" + §Verification §Interplay) on the REAL loop
 * rather than a fake context — the ledger is released, the listeners must stop
 * emitting, and the release handle must be inert on a second call.
 *
 * NOTE for the reviewer: this file's name is a leftover scratch name from
 * development (the session could not delete or rename it); it belongs beside
 * `integration.spec.ts` and should be renamed to `mount-lifecycle.spec.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as inputLedger from '../src/index.ts'
import { mountStateOf } from '../src/index.ts'
import { bootAndRun, cleanupRoots, ledgerRowsOf, waitFor } from './real-boot-rig.ts'

afterEach(cleanupRoots)

describe('input-ledger real boot: one row per request and the mount lifecycle', () => {
  it('is a cordis plugin: the preset row mounts it, and its unload releases the observers', async () => {
    // The preset mounts this package as a plain plugin row (no Service), exactly
    // like progress-rebuild — so the module MUST export an `apply` that cordis
    // can start. Without it the loader reports "input-ledger: never started" and
    // the whole cc preset fails to compose a session (smoke:profile-boot).
    expect(inputLedger.name).toBe('input-ledger')
    const ctx = new Context()
    await ctx.plugin(inputLedger)
    expect(mountStateOf(ctx)).toEqual({ listenerCount: 3, refs: 1 })
    // Preset unload disposes the plugin fiber, which releases this mount.
    await ctx.fiber.dispose()
    expect(mountStateOf(ctx)).toBeUndefined()
  }, 30_000)

  it('emits exactly one request row per model call and disposes on release', async () => {
    const boot = await bootAndRun(true)
    const first = await waitFor(async () => {
      const rows = await ledgerRowsOf(boot.home)
      return rows.requests.length >= 3 ? rows : undefined
    }, 'three request rows')
    expect(first.requests).toHaveLength(3)
    // The three rows are the three calls the loop actually made: the ledger
    // neither duplicates an emission (double include) nor drops one.
    expect(first.requests.map((row) => row.seqPerGen)).toEqual([1, 2, 3])

    // The mount is registered on the root context of this boot.
    expect(mountStateOf(boot.ctx)).toEqual({ listenerCount: 3, refs: 1 })
    // …and releasing it (the preset unload path) tears the listeners down.
    boot.release!()
    expect(mountStateOf(boot.ctx)).toBeUndefined()

    // One more turn, served by the scripted adapter: no observer is left to
    // write a row, so the ledger stays at three.
    boot.agent.followup({ content: [{ type: 'text', text: 'after release' }], source: { kind: 'user' } } as never)
    await boot.agent.whenIdle()
    expect(boot.requests).toHaveLength(4)
    const after = await ledgerRowsOf(boot.home)
    expect(after.requests).toHaveLength(3)

    // A second release is inert (the handle guards itself).
    expect(() => boot.release!()).not.toThrow()
    expect(mountStateOf(boot.ctx)).toBeUndefined()

    await boot.ctx.fiber.dispose()
  }, 30_000)
})
