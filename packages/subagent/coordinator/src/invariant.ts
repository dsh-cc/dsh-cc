/**
 * Package-owned invariant companion for `@dsh-cc/coordinator`.
 * @module @dsh-cc/coordinator/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-cc/coordinator'

/** Cordis companion plugin name. */
export const name = 'coordinator-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this agent-scoped adapter has no independent lifecycle
 * stream; restriction, prompt-section, and worker bookkeeping effects are
 * owned by the subagent service it calls and are asserted directly by tests.
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
