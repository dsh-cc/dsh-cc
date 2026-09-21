/**
 * Package-owned invariant companion for `@dsh-cc/compaction-cost-gate`.
 * @module @dsh-cc/compaction-cost-gate/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-cc/compaction-cost-gate'

/** Cordis companion plugin name. */
export const name = 'compaction-cost-gate-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the gate is a pure arithmetic fold unit-tested
 * table-side, the two-seam split (post-execute arming / idle action) is
 * pinned by the service and composition specs, and the harness compaction
 * engine already enforces the idle-only `compactNow` contract itself.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
