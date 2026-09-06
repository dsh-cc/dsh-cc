/**
 * Package-owned invariant companion for `@dsh-cc/command-stats`.
 * @module @dsh-cc/command-stats/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-cc/command-stats'

/** Cordis companion plugin name. */
export const name = 'command-stats-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this command adapter owns no event stream or state projection; statistics
 * folding is a pure function over the session's authoritative event log and the command registry owns
 * registration and dispatch lifecycle.
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
