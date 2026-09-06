/**
 * Package-owned invariant companion for `@dsh-cc/tool-git-worktree`.
 * @module @dsh-cc/tool-git-worktree/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@dsh-cc/tool-git-worktree'

/** Cordis companion plugin name. */
export const name = 'tool-git-worktree-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: git is an external process the package never vends a
 * snapshot of, and the active worktree session is process-local navigation
 * state rather than a durable published projection a companion could cross-check.
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
