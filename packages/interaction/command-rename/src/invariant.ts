/**
 * Package-owned invariant companion for `@dsh-cc/command-rename`.
 * @module @dsh-cc/command-rename/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-cc/command-rename'

/** Cordis companion plugin name. */
export const name = 'command-rename-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the command is a thin adapter over the optional host
 * `sessionTitle` seam; the title service owns rename acceptance, title-pin
 * semantics, and the `session/title` log projection.
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
