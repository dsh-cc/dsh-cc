/**
 * Package-owned invariant companion for `@dsh-cc/settings-cascade`.
 * @module @dsh-cc/settings-cascade/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-cc/settings-cascade'

/** Cordis companion plugin name. */
export const name = 'settings-cascade-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this provider's contracts are the cross-file merge
 * and policy first-source-wins — composition logic proven by package tests;
 * the in-process commit relation is owned by `@deepseek-ai/dsh-settings`.
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
