/**
 * Package-owned invariant companion for `@dsh-cc/command-compact`.
 * @module @dsh-cc/command-compact/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-cc/command-compact'

/** Cordis companion plugin name. */
export const name = 'command-compact-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the command is a thin adapter over the compaction
 * seam (upstream-verified) and the hint lifecycle is finally-block cleared,
 * so no cross-event postcondition exists to guard.
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
