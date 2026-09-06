/**
 * Package-owned invariant companion for `@dsh-cc/compaction-basic`.
 * @module @dsh-cc/compaction-basic-cc/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-cc/compaction-basic'

/** Cordis companion plugin name. */
export const name = 'compaction-basic-cc-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the hint seam is a WeakMap keyed by the live agent
 * (consumed once by `summarize()`), so cross-agent leakage and hint reuse
 * are impossible by construction rather than by postcondition.
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
