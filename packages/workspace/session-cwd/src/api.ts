/**
 * Session cwd APIs. `getSessionCwd` resolves the authoritative session
 * working directory (live overlay → durable `worktree/entered` fold →
 * session header → fallback); `setSessionCwd` records the change durably by
 * appending a `worktree/entered` event and updating the live overlay.
 *
 * @module @dsh-cc/session-cwd/api
 */

import { isAbsolute, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { appendWorktreeEntered } from './events.ts'
import { sessionCwdStore, type SessionCwdStore } from './state.ts'

/** Options accepted by the cwd APIs; default to the shared process store. */
export interface SessionCwdOptions {
  /** The store to read/write; defaults to the process-wide singleton. */
  store?: SessionCwdStore
  /** Final fallback when neither the log nor the header records a cwd. */
  fallback?: string
}

/**
 * Shared resolution body for the session-cwd resolvers: live store overlay →
 * durable `worktree/entered` fold → session header cwd → caller fallback →
 * `undefined`. Contains the resolution body's grandfathered
 * `session.snapshotEvents()` call (upstream deprecation: new calls prohibited).
 * @param session - the session whose cwd is being resolved.
 * @param options - store and fallback overrides.
 * @returns the absolute session cwd, or `undefined` when nothing records one.
 */
function resolveSessionCwd(
  session: Pick<Agent['session'], 'id' | 'header' | 'snapshotEvents'>,
  options: SessionCwdOptions = {},
): string | undefined {
  const { store = sessionCwdStore, fallback } = options
  const sessionId = String(session.id)
  return store.resolve(sessionId, session.snapshotEvents())
    ?? session.header.cwd
    ?? fallback
}

/**
 * Read the authoritative session working directory for a session directly.
 * Resolution order: the live store overlay, the durable `worktree/entered`
 * fold, the session header cwd, then the caller's fallback — no
 * `process.cwd()` fallback, so "unresolvable" stays observable (`undefined`).
 * @param session - the session whose cwd is being read.
 * @param options - store and fallback overrides.
 * @returns the absolute session cwd, or `undefined` when unresolvable.
 */
export function getSessionCwdForSession(
  session: Session,
  options: SessionCwdOptions = {},
): string | undefined {
  return resolveSessionCwd(session, options)
}

/**
 * Read the authoritative session working directory. Resolution order: the
 * live store overlay, the durable `worktree/entered` fold, the session
 * header cwd, then the caller's fallback (defaulting to the process cwd).
 * @param agent - the live agent whose session cwd is being read.
 * @param options - store and fallback overrides.
 * @returns the absolute session cwd.
 */
export function getSessionCwd(agent: Agent, options: SessionCwdOptions = {}): string {
  return resolveSessionCwd(agent.session, options)
    ?? process.cwd()
}

/**
 * Change the session's working directory: append a durable `worktree/entered`
 * event (last-wins fold) and update the live overlay. The path must be
 * absolute and is normalized before writing.
 * @param agent - the live agent whose session cwd is changing.
 * @param path - the new absolute working directory.
 * @param options - store override.
 */
export function setSessionCwd(agent: Agent, path: string, options: SessionCwdOptions = {}): void {
  if (!isAbsolute(path)) {
    throw new TypeError(`session cwd must be an absolute path: "${path}"`)
  }
  const { store = sessionCwdStore } = options
  const normalized = resolve(path)
  appendWorktreeEntered(agent.session, normalized)
  store.set(String(agent.session.id), normalized)
}
