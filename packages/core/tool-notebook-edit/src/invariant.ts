/**
 * Package-owned invariant companion for `@dsh-cc/tool-notebook-edit`.
 * @module @dsh-cc/tool-notebook-edit/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-cc/tool-notebook-edit'

/** Cordis companion plugin name. */
export const name = 'tool-notebook-edit-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No durable runtime invariant: the read-before-write baseline lives only in
 * the plugin's `apply`-registered closure and is torn down with the plugin
 * scope, so there is no persistent projection a companion could cross-check.
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
