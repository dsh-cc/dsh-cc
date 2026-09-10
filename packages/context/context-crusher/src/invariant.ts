/**
 * Package-owned invariant companion for `@dsh-cc/context-crusher`.
 * @module @dsh-cc/context-crusher/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-cc/context-crusher'

/** Cordis companion plugin name. */
export const name = 'context-crusher-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the crusher's safety contract is enforced at the
 * source — post-`next()` composition never converts a non-accept decision,
 * the D2/D11 block shape is pinned by composition tests, and every I/O path
 * fails closed to passthrough rather than relying on a cross-event check.
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
