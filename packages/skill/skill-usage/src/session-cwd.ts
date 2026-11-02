/**
 * Per-call session-cwd resolution for the session-only listeners
 * (`session/event`, `session/created`). `@dsh-cc/session-cwd`'s facade takes
 * an AGENT, and these seams only hand us the session — so this mirrors the
 * facade's resolution order against the plugin's own context: the harness
 * `workingDirectory` projection when the service is present in the realm,
 * else the legacy `worktree/entered` fold, else the session header cwd.
 *
 * Resolved PER CALL (never statically injected and never captured at apply
 * time): the service may mount after this plugin, and a static inject would
 * park the plugin in PENDING.
 *
 * @module @dsh-cc/skill-usage/session-cwd
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { foldSessionCwd } from '@dsh-cc/session-cwd'

/** Structural face of the upstream `sessionProjections` registry. */
interface SessionProjectionsLike {
  stateOf(session: Session, key: 'workingDirectory'): unknown
}

/**
 * Resolve the session's working directory, or `undefined` when nothing
 * records one (the caller then skips its row — today's semantics).
 * Never throws: every cordis access is guarded.
 * @param ctx - the plugin context of the calling listener.
 * @param session - the session whose cwd is being resolved.
 * @returns the live session cwd, or `undefined`.
 */
export function sessionCwdOf(ctx: Context, session: Session): string | undefined {
  try {
    const service = ctx.get('workingDirectory')
    if (service !== undefined) {
      const projections = ctx.get('sessionProjections') as SessionProjectionsLike | undefined
      const value = projections?.stateOf(session, 'workingDirectory')
      // A registered projection with a `null` state is authoritative absence;
      // `undefined` means the key is unregistered in this realm — only then
      // does the legacy fold apply (same contract as the session-cwd facade).
      if (value !== undefined) return typeof value === 'string' ? value : undefined
    }
  } catch {
    // Un-injected service access throws; degrade to the legacy fold.
  }
  return foldSessionCwd(session.snapshotEvents()) ?? session.header.cwd
}
