/**
 * Package-owned invariant companion for `@dsh-cc/session-title-provider`.
 * @module @dsh-cc/session-title-provider/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-cc/session-title-provider'

/** Cordis companion plugin name. */
export const name = 'session-title-provider-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the provider is a stateless adapter over the host
 * `sessionTitle` registry and the shared session-title-llm call policy; the
 * title service owns registration, acceptance, and projection lifecycle.
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
