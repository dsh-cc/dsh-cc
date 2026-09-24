/**
 * The `permission/classifier` audit-event surface: the event type and its
 * registration, the payload shape (digest-first; reason capped and
 * sanitized), the fold + append helpers, and the D5 deny-backstop state
 * (thresholds, trip notice, fold, per-session seed-once tracker).
 * Extracted from auto-stage.ts for the file-size budget — behavior identical.
 * @module @dsh-cc/permission-rules/classifier-audit
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** The session event type carrying one classifier verdict audit record. */
export const CLASSIFIER_EVENT = 'permission/classifier'

// Cross-repo event registration: postdates the upstream session catalog
// (same pattern as `permission/mode` / `permission/session-allow`).
;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add(CLASSIFIER_EVENT)

/** The `permission/classifier` payload. The raw classifier input NEVER appears — only its digest. */
export interface ClassifierAuditEventData {
  /** The tool the verdict is about. */
  tool: string
  /** sha256 of the rendered classifier input (absent on the arming `unarmed` record). */
  digest?: string
  verdict: 'allow' | 'ask' | 'deny'
  /** On `deny`: the exact cited hard_deny rule text (S4/D4/D5). */
  rule?: string
  /** The registry tool-call id, when the execution carries one (S4/D5). */
  callId?: string
  failure?: 'timeout' | 'error' | 'malformed' | 'unarmed' | 'breaker' | 'cancelled' | 'stale-mode' | 'trip'
  /** Short model/availability reason (D10): ≤120 chars, control chars stripped at write. */
  reason?: string
  /** Present (true) when the D13 reconsider pass ran for this verdict. */
  secondPass?: boolean
  route?: string
  provider?: string
  model?: string
  latencyMs: number
  cacheHit: boolean
}

/** D10: audit `reason` cap. */
export const REASON_CAP = 120

/**
 * Strip control characters and cap an audit reason at {@link REASON_CAP}
 * chars. Shared with the S7 PI probe (same package — D10).
 */
export function sanitizeReason(reason: string): string {
  return reason.replace(/[\x00-\x1f\x7f]/g, '').slice(0, REASON_CAP)
}

/** Wire face of one log event that may or may not be a `permission/classifier`. */
interface ClassifierWire {
  readonly type: string
  readonly data: ClassifierAuditEventData
}

/**
 * Append one `permission/classifier` audit record through the widened session
 * append face (same cross-pin strategy as `./mode.ts` and
 * `./session-allowlist.ts`).
 */
export function appendSessionClassifier(session: Session, data: ClassifierAuditEventData): void {
  type AppendFace = { append(type: string, data: ClassifierAuditEventData): unknown }
  ;(session as unknown as AppendFace).append(CLASSIFIER_EVENT, data)
}

/**
 * Fold a session log into the classifier verdict records it carries, in log
 * order. Foreign event types are skipped; resume/replay reconstructs why a
 * call did or did not prompt.
 */
export function foldClassifiers(events: readonly SessionEvent[]): ClassifierAuditEventData[] {
  const out: ClassifierAuditEventData[] = []
  for (const event of events) {
    const wire = event as unknown as ClassifierWire
    if (wire.type !== CLASSIFIER_EVENT || typeof wire.data !== 'object' || wire.data === null) continue
    out.push(wire.data)
  }
  return out
}

/** D5 backstop thresholds (module constants — no settings knob). */
export const DENY_STREAK_THRESHOLD = 3
export const DENY_TOTAL_THRESHOLD = 20

/** The notice injected when the deny backstop trips (D5 — never the "changed by the user" template). */
export const TRIP_NOTICE =
  "Auto mode paused: the permission classifier's denial threshold was reached (3 consecutive or 20 total blocks). Switch back with /permissions auto after reviewing the blocked actions."

/**
 * Pure fold over classifier audit records (log order) computing the D5 deny
 * counters. The window starts AFTER the most recent `failure: 'trip'` marker
 * (the trip downgraded the mode, so a re-entry into auto restarts from zero).
 * `consecutive` is the trailing streak of `verdict: 'deny'` events, reset by
 * any later REAL non-deny verdict (`failure === undefined && verdict !==
 * 'deny'`) — synthetic records (`unarmed`/`breaker`/`stale-mode`/`trip`) NEVER
 * reset it (A16). `total` is the cumulative deny count within the window.
 */
export function foldDenyBackstop(events: readonly ClassifierAuditEventData[]): { consecutive: number; total: number } {
  let start = 0
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.failure === 'trip') start = i + 1
  }
  let consecutive = 0
  let total = 0
  for (const event of events.slice(start)) {
    if (event.verdict === 'deny') {
      consecutive += 1
      total += 1
    } else if (event.failure === undefined) {
      consecutive = 0
    }
  }
  return { consecutive, total }
}

/**
 * The per-session deny backstop (D5, seed-once idiom): the session's durable
 * log is folded ONCE on its first deny-eligible outcome, and every event the
 * stage audits afterwards is folded in-process — never a per-verdict full
 * scan. Tripping is implicit in the fold: the appended `trip` marker re-windows
 * the state to zero, so a second crossing (and the notice) requires a FRESH
 * threshold after re-entry — idempotent by construction.
 */
export class DenyBackstop {
  private readonly seeded = new Set<string>()
  private readonly seededEvents = new Map<string, ClassifierAuditEventData[]>()
  private readonly liveEvents = new Map<string, ClassifierAuditEventData[]>()

  /** Seed once per session id from its durable log; '' (no session) skips. */
  seed(sessionId: string, loadEvents: () => readonly ClassifierAuditEventData[]): void {
    if (sessionId === '' || this.seeded.has(sessionId)) return
    this.seeded.add(sessionId)
    if (this.seededEvents.has(sessionId)) return
    this.seededEvents.set(sessionId, [...loadEvents()])
  }

  /** Fold one newly audited event into the in-process window. */
  record(sessionId: string, event: ClassifierAuditEventData): void {
    if (sessionId === '') return
    const live = this.liveEvents.get(sessionId) ?? []
    live.push(event)
    this.liveEvents.set(sessionId, live)
  }

  /** Current {consecutive, total} for the session (seeded window + live events). */
  state(sessionId: string): { consecutive: number; total: number } {
    if (sessionId === '') return { consecutive: 0, total: 0 }
    const events = [...(this.seededEvents.get(sessionId) ?? []), ...(this.liveEvents.get(sessionId) ?? [])]
    return foldDenyBackstop(events)
  }
}
