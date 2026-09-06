/**
 * Foldable session cwd state. The durable state is the session event log
 * itself (`worktree/entered`, last-wins); this module folds it into a typed
 * state value and adds a process-local live overlay for the current session
 * (the same pattern as tool-git-worktree's active worktree session), which
 * lets `getSessionCwd` read back before the event round-trips and keeps
 * sessions independent inside one process.
 *
 * @module @dsh-cc/session-cwd/state
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldSessionCwd } from './events.ts'

/** The folded cwd state of one session: the current cwd, when known. */
export interface SessionCwdState {
  readonly cwd?: string
}

/** The empty state: no cwd recorded in this fold. */
export const EMPTY_SESSION_CWD_STATE: SessionCwdState = {}

/**
 * Reduce one event into the state. Only `worktree/entered` events change the
 * state; everything else passes through unchanged (a fold, not a filter).
 * @param state - the state so far.
 * @param event - the next session event in log order.
 * @returns the next state.
 */
export function reduceSessionCwdState(state: SessionCwdState, event: SessionEvent): SessionCwdState {
  const wire = event as unknown as { type: string; data?: { path?: unknown } }
  if (wire.type !== 'worktree/entered' || typeof wire.data?.path !== 'string') return state
  return { cwd: wire.data.path }
}

/**
 * Fold the cwd state over a session event log, in log order.
 * @param events - session events in log order.
 * @returns the folded state (empty when no event applied).
 */
export function foldSessionCwdState(events: readonly SessionEvent[]): SessionCwdState {
  let state = EMPTY_SESSION_CWD_STATE
  for (const event of events) state = reduceSessionCwdState(state, event)
  return state
}

/**
 * Process-local cwd overlay keyed by session id. Writes are applied on
 * `setSessionCwd`; reads fall through to the durable event-log fold so a
 * restarted process still resolves the cwd from the persisted session.
 */
export class SessionCwdStore {
  private readonly live = new Map<string, string>()

  /**
   * Record the live cwd for one session.
   * @param sessionId - the session key.
   * @param cwd - the new absolute cwd.
   */
  set(sessionId: string, cwd: string): void {
    this.live.set(sessionId, cwd)
  }

  /** The live cwd for one session, or `undefined` without a local write. */
  get(sessionId: string): string | undefined {
    return this.live.get(sessionId)
  }

  /**
   * Resolve the authoritative cwd for one session: the live overlay first,
   * then the durable event-log fold.
   * @param sessionId - the session key.
   * @param events - the session's event log, in log order.
   * @returns the resolved cwd, or `undefined` when nothing is recorded.
   */
  resolve(sessionId: string, events: readonly SessionEvent[]): string | undefined {
    return this.live.get(sessionId) ?? foldSessionCwd(events)
  }

  /** Drop the live overlay for one session (used on session dispose). */
  clear(sessionId: string): void {
    this.live.delete(sessionId)
  }
}

/** The process-wide cwd overlay shared by the plugin, APIs, and listener. */
export const sessionCwdStore = new SessionCwdStore()
