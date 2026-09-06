/**
 * Package-owned invariant companion for `@dsh-cc/web-fetch-http`.
 * @module @dsh-cc/web-fetch-http/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-cc/web-fetch-http'

/** Cordis companion plugin name. */
export const name = 'web-fetch-http-cc-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the provider composes a pure URL gate with the
 * harness `HttpFetchProvider` transport, neither of which publishes a durable
 * projection a companion could cross-check.
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
