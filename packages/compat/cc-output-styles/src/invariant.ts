/**
 * Package-owned invariant companion for `@dsh-cc/output-styles`.
 * @module @dsh-cc/output-styles/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-cc/output-styles'

/** Cordis companion plugin name. */
export const name = 'cc-output-styles-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the output-style section text is a pure function of
 * the selected style (`styleSectionText`), and the switch contract — a settings
 * write re-emitting `system-prompt/change`, and `/output-style` rejecting
 * unknown names — is asserted by the package behavioral suite rather than a
 * stateful projection or event pairing this companion owns.
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
