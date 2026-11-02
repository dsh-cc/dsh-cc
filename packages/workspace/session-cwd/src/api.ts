/**
 * Session cwd facade. The harness `workingDirectory` service owns the session
 * directory; these resolvers read it synchronously through the agent's own
 * context and fall back to the legacy `worktree/entered` fold only when the
 * service is absent in the realm.
 *
 * @module @dsh-cc/session-cwd/api
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { foldSessionCwd } from './events.ts'

/** Structural face of the upstream `sessionProjections` registry. */
interface SessionProjectionsLike {
  /** Sync, undefined-able cold read of one projection unit. */
  stateOf(session: Session, key: 'workingDirectory'): unknown
}

/** Options accepted by the cwd facade. */
export interface SessionCwdOptions {
  /** Final fallback when neither the service nor the legacy log records a cwd. */
  fallback?: string
}

/**
 * Legacy read path: the durable `worktree/entered` fold, then the session
 * header cwd. Contains the facade's grandfathered `session.snapshotEvents()`
 * call (upstream deprecation: new call sites are prohibited).
 * @param session - the session whose cwd is being resolved.
 * @returns the folded or header cwd, or `undefined` when nothing records one.
 */
function legacySessionCwd(session: Session): string | undefined {
  return foldSessionCwd(session.snapshotEvents()) ?? session.header.cwd
}

/**
 * Resolve the authoritative session working directory without coalescing:
 * service-backed state when the harness service is present in the realm, else
 * the legacy `worktree/entered` fold, else the session header cwd.
 *
 * Never throws: every cordis access is guarded, so a bare or TUI-style agent
 * fixture degrades to the legacy fold instead of failing the caller.
 * @param agent - the live agent whose session cwd is being read.
 * @returns the session cwd, or `undefined` when unresolvable.
 */
export function resolveSessionCwd(agent: Agent): string | undefined {
  try {
    const service = agent.ctx.get('workingDirectory')
    if (service !== undefined) {
      const projections = agent.ctx.get('sessionProjections') as SessionProjectionsLike | undefined
      const value = projections?.stateOf(agent.session, 'workingDirectory')
      // A registered projection whose state is `null` means "no header cwd and
      // no events" — authoritative absence, so the legacy fold must not
      // supersede it. `undefined` means the key is unregistered in this realm:
      // only then does the facade fall through to the legacy fold.
      if (value !== undefined) return typeof value === 'string' ? value : undefined
    }
  } catch {
    // Un-injected service access throws; degrade to the legacy fold.
  }
  return legacySessionCwd(agent.session)
}

/**
 * Read the authoritative session working directory. Resolution order: the
 * harness service, the legacy fold, the session header cwd, the caller
 * fallback, then the process cwd.
 * @param agent - the live agent whose session cwd is being read.
 * @param options - caller fallback override.
 * @returns the absolute session cwd (total).
 */
export function getSessionCwd(agent: Agent, options: SessionCwdOptions = {}): string {
  return resolveSessionCwd(agent) ?? options.fallback ?? process.cwd()
}
