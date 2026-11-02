/**
 * Durable session cwd events. This module registers the `worktree/entered`
 * session event type into the upstream `KNOWN_SESSION_EVENT_TYPES` set at
 * load (required for persistence-layer compatibility: persistence refuses
 * unknown event types unless the type is registered there). The set is typed
 * `ReadonlySet` but is a live `Set` — same cross-repo registration pattern as
 * `permission/mode` in `@dsh-cc/permission-rules`.
 *
 * The event payload is read through a local wire face (`WorktreeEnteredWire`)
 * rather than `SessionEventMap['worktree/entered']`, which the typed map does
 * not carry: legacy logs stay readable, but nothing new is written here.
 *
 * @module @dsh-cc/session-cwd/events
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** The session event type carrying a session cwd change. */
export const WORKTREE_ENTERED_EVENT = 'worktree/entered'

;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add(WORKTREE_ENTERED_EVENT)

/**
 * The `worktree/entered` payload as written by this plugin: the new absolute
 * session working directory. `ExitWorktree` restores the previous directory
 * through the same event (last-wins fold), so one type covers both moves.
 */
export interface WorktreeEnteredEventData {
  path: string
}

/** Wire face of one log event that may or may not be a `worktree/entered`. */
interface WorktreeEnteredWire {
  readonly type: string
  readonly data: WorktreeEnteredEventData
}

/** Read a log event through the extended `worktree/entered` face. */
function asEnteredEvent(event: SessionEvent): WorktreeEnteredWire {
  return event as unknown as WorktreeEnteredWire
}

/**
 * Fold the session's current working directory from its event log: the last
 * `worktree/entered` path, or `undefined` when the session never recorded one
 * (callers apply the process/session default).
 * @param events - session events in log order (other event types are skipped).
 * @returns the last recorded cwd, or `undefined` without one.
 */
export function foldSessionCwd(events: readonly SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = asEnteredEvent(events[i]!)
    if (event.type === WORKTREE_ENTERED_EVENT && typeof event.data?.path === 'string') {
      return event.data.path
    }
  }
  return undefined
}
