/**
 * Package-owned invariant companion for `@dsh-cc/tool-sleep`.
 * @module @dsh-cc/tool-sleep/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-cc/tool-sleep'

/** Cordis companion plugin name. */
export const name = 'tool-sleep-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: Sleep waits on a wall-clock timer and a cancellation
 * signal, neither of which publishes a durable projection a companion could
 * cross-check.
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
