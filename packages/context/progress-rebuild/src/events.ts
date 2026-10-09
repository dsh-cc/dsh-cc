/**
 * Event-face wiring for the progress-rebuild package:
 * the host-only `progress-rebuild` projection key (SessionProjectionStateMap
 * augmentation — no wire/SessionProjectionMap entry, §3.1) and the durable
 * `progress-rebuild/injected` session event type (runtime registration +
 * widened-append face, session-cwd precedent).
 *
 * @module @dsh-cc/progress-rebuild/events
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProgressRebuildState } from './state.ts'

/** The session event type carrying a post-compact rebuild brief. */
export const PROGRESS_REBUILD_INJECTED_EVENT = 'progress-rebuild/injected'

;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add(PROGRESS_REBUILD_INJECTED_EVENT)

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host-only progress-state projection owned by @dsh-cc/progress-rebuild. */
    'progress-rebuild': ProgressRebuildState
  }
}

/** The `progress-rebuild/injected` payload: dogfood measurement (§3.3 step 4). */
export interface ProgressRebuildInjectedEventData {
  /** UTF-8 byte size of the delivered brief text. */
  bytes: number
  /** Number of top-level sections rendered. */
  sections: number
  /** Which delivery path landed the brief. */
  path: 'pre-step' | 'inject'
}

/** Wire face of one log event that may or may not be a `progress-rebuild/injected`. */
interface ProgressRebuildInjectedWire {
  readonly type: string
  readonly data: ProgressRebuildInjectedEventData
}

/**
 * Append one durable `progress-rebuild/injected` event (widened-append face:
 * the typed event map gains this key only when the host types it; here the
 * append goes through the runtime-registered type).
 * @param session - the session the brief belongs to.
 * @param payload - the rendered brief payload.
 */
export function appendProgressRebuildInjected(session: Session, payload: ProgressRebuildInjectedEventData): void {
  ;(session.append as unknown as (type: string, payload: ProgressRebuildInjectedEventData) => unknown)(
    PROGRESS_REBUILD_INJECTED_EVENT,
    payload,
  )
}

/** Read a log event through the extended `progress-rebuild/injected` face. */
export function asInjectedEvent(event: SessionEvent): ProgressRebuildInjectedWire {
  return event as unknown as ProgressRebuildInjectedWire
}
