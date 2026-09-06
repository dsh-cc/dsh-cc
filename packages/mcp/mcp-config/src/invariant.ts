/**
 * Package-owned invariant companion for `@dsh-cc/mcp-config`.
 * @module @dsh-cc/mcp-config/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-cc/mcp-config'

/** Cordis companion plugin name. */
export const name = 'mcp-config-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: aside from `migrate.ts`'s atomic, user-invoked file
 * write, mcp-config produces registrations and introduces no live registries
 * of its own to reconcile.
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
