/**
 * Package-owned invariant companion for `@dsh-cc/tui`.
 * @module @dsh-cc/tui/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-cc/tui'

/** Cordis companion plugin name. */
export const name = 'dsh-cc-tui-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the TUI is a protocol driver over session/event and
 * does not own a durable projection.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
