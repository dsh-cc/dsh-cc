/**
 * Package-owned invariant companion for `@dsh-cc/tool-search`.
 * @module @dsh-cc/tool-search/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-cc/tool-search'

/** Cordis companion plugin name. */
export const name = 'tool-search-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns no event or snapshot of its own. The
 * relation it establishes — a deferred tool being loaded into the tool registry
 * after a ToolSearch hit — is the tool registry's to hold, and `dsh-tools`
 * observes registration there through `tools/change`.
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
