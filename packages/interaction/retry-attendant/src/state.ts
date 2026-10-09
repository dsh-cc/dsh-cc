/**
 * Per-session in-memory M2 state (design doc
 * docs/plans/2026-10-09-verify-before-retry.md §3.3): a map of live
 * ambiguous-outcome entries keyed by session id then effect digest, plus the
 * reservation index that ties an in-flight ask to its owning execution
 * `callId`. Deliberately ephemeral (no disk); agent-less executions never
 * key into it. Expiry sweeps drop entries older than `expireMinutes` — the
 * sweep also releases `askInFlight`, so a call whose resolution seams never
 * fire cannot wedge the key.
 *
 * @module
 */

/** One live ambiguous-outcome entry. */
export interface RetryEntry {
  recordedAt: number
  /** The failure class that fired (data/classes.json). */
  class: string
  /** The tool call name the outcome belonged to. */
  tool: string
  /** Head of the model-facing outcome text (telemetry/debug). */
  outcomeHead: string
  /** Consumed consultation: an allowed-once dispatch was observed. */
  escalated?: true
  /** A consultation (ask) is currently in flight. */
  askInFlight?: true
  /** A designated check succeeded in between — the retry asks harder. */
  resolved?: true
  /** Description of the designated check that resolved the entry. */
  check?: string
  /** When the designated check ran. */
  checkAt?: number
  /** Target path, stored for the write-partial designated check. */
  filePath?: string
}

/** Reservation: an ask returned by pre-execute, keyed by its owning callId. */
export interface Reservation {
  sessionId: string
  digest: string
}

/** The mutable per-plugin state. */
export interface RetryState {
  sessions: Map<string, Map<string, RetryEntry>>
  reservations: Map<string, Reservation>
}

export function createState(): RetryState {
  return { sessions: new Map(), reservations: new Map() }
}

/** Session map for `sessionId` (created on demand). */
function sessionMap(state: RetryState, sessionId: string): Map<string, RetryEntry> {
  let map = state.sessions.get(sessionId)
  if (map === undefined) {
    map = new Map()
    state.sessions.set(sessionId, map)
  }
  return map
}

/** Drop expired entries for one session (and their dangling reservations). */
export function sweep(state: RetryState, expireMs: number, sessionId: string, now = Date.now()): void {
  const map = state.sessions.get(sessionId)
  if (map === undefined) return
  for (const [digest, entry] of map) {
    if (now - entry.recordedAt > expireMs) {
      map.delete(digest)
      releaseReservation(state, sessionId, digest)
    }
  }
}

/** The live (non-expired) entry for a digest, after sweeping the session. */
export function liveEntry(state: RetryState, expireMs: number, sessionId: string, digest: string, now = Date.now()): RetryEntry | undefined {
  sweep(state, expireMs, sessionId, now)
  return state.sessions.get(sessionId)?.get(digest)
}

/**
 * Record a fresh ambiguous outcome: only when the key is absent or expired;
 * NEVER resets a live entry (an `escalated` mark must survive). Returns
 * whether an entry was recorded.
 */
export function recordEntry(state: RetryState, sessionId: string, digest: string, entry: RetryEntry): boolean {
  const map = sessionMap(state, sessionId)
  const existing = map.get(digest)
  // Expired entries were already swept by the caller (liveEntry/sweep), so
  // presence here means a live entry — never reset (esp. an escalated one).
  if (existing !== undefined) return false
  map.set(digest, entry)
  return true
}

/** Fully clear one digest (same-digest clean success). */
export function clearEntry(state: RetryState, sessionId: string, digest: string): void {
  state.sessions.get(sessionId)?.delete(digest)
  releaseReservation(state, sessionId, digest)
}

/** Mark `resolved:true` on every live entry matching the predicate. */
export function resolveEntries(state: RetryState, sessionId: string, match: (entry: RetryEntry) => boolean, check: string, now = Date.now()): void {
  const map = state.sessions.get(sessionId)
  if (map === undefined) return
  for (const entry of map.values()) {
    if (match(entry)) {
      entry.resolved = true
      entry.check = check
      entry.checkAt = now
    }
  }
}

/** Reserve the in-flight ask to its owning execution. */
export function reserve(state: RetryState, callId: string, sessionId: string, digest: string): void {
  state.reservations.set(callId, { sessionId, digest })
}

/**
 * Positive dispatch evidence: the owning execution reached `tools/execute` ⇒
 * consume the latch (`escalated:true`, release `askInFlight`).
 */
export function consumeDispatch(state: RetryState, callId: string): void {
  const reservation = state.reservations.get(callId)
  if (reservation === undefined) return
  state.reservations.delete(callId)
  const entry = state.sessions.get(reservation.sessionId)?.get(reservation.digest)
  if (entry === undefined) return
  entry.escalated = true
  delete entry.askInFlight
}

/**
 * Terminal release: the owning execution's `tools/result` without prior
 * dispatch evidence ⇒ release `askInFlight`, entry stays un-escalated
 * (rejection does not consume). A denied sibling's callId owns no
 * reservation and is a no-op here.
 */
export function releaseReservation(state: RetryState, sessionId: string, digest: string): void
export function releaseReservation(state: RetryState, callId: string): void
export function releaseReservation(state: RetryState, sessionIdOrCallId: string, digest?: string): void {
  const callIds = digest === undefined
    ? [sessionIdOrCallId]
    : [...state.reservations.entries()].filter(([, r]) => r.sessionId === sessionIdOrCallId && r.digest === digest).map(([id]) => id)
  for (const callId of callIds) {
    const reservation = state.reservations.get(callId)
    if (reservation === undefined) continue
    state.reservations.delete(callId)
    const entry = state.sessions.get(reservation.sessionId)?.get(reservation.digest)
    if (entry !== undefined) delete entry.askInFlight
  }
}
