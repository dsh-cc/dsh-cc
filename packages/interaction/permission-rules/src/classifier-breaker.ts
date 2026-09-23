/**
 * The shared per-route breaker/streak machinery (S7/W1): extracted
 * behavior-identically from `./auto-stage.ts` so the LLM classifier stage and
 * the input-layer PI probe (`./pi-probe.ts`) fold failure streaks with ONE
 * implementation. Pure bookkeeping — no session access, no I/O beyond the
 * injected warn/audit callbacks.
 *
 * @module @dsh-cc/permission-rules/classifier-breaker
 */

/**
 * Consecutive per-route failures before that route's breaker opens (module
 * constant — no settings knob by design).
 */
export const CLASSIFIER_BREAKER_THRESHOLD = 3

/** The failure tags the breaker counts; `cancelled`/`unarmed` are host noise and never count. */
export const BREAKER_FAILURE_TAGS: readonly string[] = ['malformed', 'error', 'timeout']

/** Structural face of one attributed audit record the streak fold reads. */
export type BreakerEventFace = {
  failure?: string
  provider?: string
  model?: string
}

/**
 * Trailing consecutive per-route failure streak over attributed audit
 * records (R3, pure fold — unit-testable). Only events carrying
 * `provider`/`model` attribution matching `routeKey` count (unattributed
 * legacy events predate route keying — skipped entirely); a parsed verdict or
 * cache hit resets the streak; the {@link BREAKER_FAILURE_TAGS} increment it;
 * other tags (`cancelled`, `breaker`, `unarmed`, …) are neutral. Capped at
 * `threshold`.
 */
export function trailingRouteFailureStreak(
  events: readonly BreakerEventFace[],
  routeKey: string,
  threshold: number,
): number {
  let streak = 0
  for (const event of events) {
    if (event.provider === undefined || event.model === undefined) continue
    if (`${event.provider}/${event.model}` !== routeKey) continue
    if (event.failure === undefined) streak = 0
    else if (BREAKER_FAILURE_TAGS.includes(event.failure)) streak = Math.min(streak + 1, threshold)
  }
  return streak
}

/** Callback face for one {@link RouteBreaker} instance. */
export type RouteBreakerDeps<C> = {
  threshold: number
  /** Failure tags that count toward the streak. */
  failureTags: readonly string[]
  /** Process-log label prefix, e.g. `permission classifier`. */
  label: string
  /** Tail of the breaker-open warning (consumer's degradation note). */
  outcomeNote: string
  warn(message: string): void
  /**
   * Emit the consumer's one-`breaker`-audit-per-session record. `ctx` is the
   * consumer's opaque call context (exec + route).
   */
  auditBreakerOnce(ctx: C, routeKey: string): void
}

/**
 * Per-route consecutive-failure breaker with session-log seeding (R3). Holds
 * ALL state (route counters, open routes, per-session audit de-dup, per-process
 * warn-once, per-session seed-once) so the classifier stage and the probe share
 * the exact same semantics: threshold-3 opens, any success resets,
 * `cancelled`/`unarmed` are neutral, `reset()` (settings change — the
 * operator's "I fixed the lane") clears everything, and the durable log seeds a
 * resumed session exactly once.
 */
export class RouteBreaker<C> {
  private readonly routeFailures = new Map<string, number>()
  private readonly breakerOpen = new Set<string>()
  /** Session ids that already recorded one `breaker` audit event (one per session). */
  private readonly breakerAudited = new Set<string>()
  /** Session ids whose durable log already seeded this process's breaker state (R3). */
  private readonly seededSessions = new Set<string>()
  private warnedBreaker = false

  constructor(private readonly deps: RouteBreakerDeps<C>) {}

  /** Clear ALL breaker state (settings change / rebuild). */
  reset(): void {
    this.routeFailures.clear()
    this.breakerOpen.clear()
    this.breakerAudited.clear()
    this.seededSessions.clear()
    this.warnedBreaker = false
  }

  isOpen(routeKey: string): boolean {
    return this.breakerOpen.has(routeKey)
  }

  /**
   * Seed the per-route breaker state from a session's durable log (R3) —
   * once per session id, on its first breaker-eligible call. Synchronous
   * guard: the session id enters the seeded set BEFORE any fold, so
   * concurrent first-calls cannot double-seed. A restored streak ≥ threshold
   * opens the route at seed time (warn-once + one `breaker` audit); a log
   * that already holds a `breaker` event pre-joins the audit de-dup set so
   * replay never re-audits the same open. Never overwrites a live counter:
   * seed only when the session is unseen AND the route counter is 0/absent —
   * in-process accrual is fresher (fail-open undercounting is the accepted
   * direction). `sessionId` '' (no session) skips entirely.
   */
  seed(sessionId: string, loadEvents: () => readonly BreakerEventFace[], routeKey: string, ctx: C): void {
    if (sessionId === '' || this.seededSessions.has(sessionId)) return
    this.seededSessions.add(sessionId)
    if ((this.routeFailures.get(routeKey) ?? 0) > 0) return
    // Lazy: the durable log is folded only when this session is actually
    // seeding (seed-once — never re-folded per call).
    const events = loadEvents()
    if (events.some(event => event.failure === 'breaker')) this.breakerAudited.add(sessionId)
    const streak = trailingRouteFailureStreak(events, routeKey, this.deps.threshold)
    if (streak <= 0) return
    this.routeFailures.set(routeKey, streak)
    if (streak < this.deps.threshold) return
    this.breakerOpen.add(routeKey)
    if (!this.warnedBreaker) {
      this.warnedBreaker = true
      this.deps.warn(`${this.deps.label}: route ${routeKey} restored with ${streak} consecutive failures from the session log; breaker open for this route, ${this.deps.outcomeNote}`)
    }
    this.auditOnce(sessionId, routeKey, ctx)
  }

  /**
   * Bookkeep one attributed outcome: success (no failure tag) resets the
   * streak; a counted failure increments it, opening the breaker at
   * threshold (warn-once per process + one `breaker` audit per session).
   * Neutral tags (`cancelled`, `unarmed`, `breaker`) neither count nor reset.
   * `sessionId` '' (no session) skips only the audit — the counter still moves.
   */
  record(sessionId: string, routeKey: string, failure: string | undefined, ctx: C): void {
    if (failure === undefined) {
      this.routeFailures.set(routeKey, 0)
      return
    }
    if (!this.deps.failureTags.includes(failure)) return
    const count = (this.routeFailures.get(routeKey) ?? 0) + 1
    this.routeFailures.set(routeKey, count)
    if (count < this.deps.threshold) return
    this.breakerOpen.add(routeKey)
    if (!this.warnedBreaker) {
      this.warnedBreaker = true
      this.deps.warn(`${this.deps.label}: route ${routeKey} failed ${this.deps.threshold} consecutive classifications; breaker open for this route, ${this.deps.outcomeNote}`)
    }
    this.auditOnce(sessionId, routeKey, ctx)
  }

  /** One `breaker` audit event per session (de-dup by session id), no stream involved. */
  auditOnce(sessionId: string, routeKey: string, ctx: C): void {
    if (sessionId === '' || this.breakerAudited.has(sessionId)) return
    this.breakerAudited.add(sessionId)
    this.deps.auditBreakerOnce(ctx, routeKey)
  }
}
