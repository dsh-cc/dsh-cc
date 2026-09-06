/**
 * Package-owned invariant companion for `@dsh-cc/command-agents`.
 * @module @dsh-cc/command-agents/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-cc/command-agents'

/** Cordis companion plugin name. */
export const name = 'command-agents-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this command adapter owns no event stream or state
 * projection; the snapshot is a pure read over injected services (subagents,
 * agents, resumePinStore), and the command registry owns registration and
 * dispatch lifecycle.
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
