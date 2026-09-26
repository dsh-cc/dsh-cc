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

/**
 * Cooldown (ms) an open route breaker waits before going half-open: the first
 * call after the cooldown is admitted as the single recovery probe. Probe
 * success closes the breaker; a counted probe failure re-opens it and
 * restarts the cooldown. Module constant like the threshold (no settings knob).
 */
export const CLASSIFIER_BREAKER_COOLDOWN_MS = 60_000

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
  /** Cooldown before an open route admits its half-open probe (default {@link CLASSIFIER_BREAKER_COOLDOWN_MS}). */
  cooldownMs?: number
  /** Injectable clock in ms (default `Date.now`); tests drive the cooldown with it. */
  now?: () => number
}

/** Observable per-route breaker state. */
export type RouteBreakerState = 'closed' | 'open' | 'half-open'

/**
 * Per-route consecutive-failure breaker with session-log seeding (R3). Holds
 * ALL state (route counters, open routes, per-session audit de-dup, per-process
 * warn-once, per-session seed-once) so the classifier stage and the probe share
 * the exact same semantics: threshold-3 opens, any success resets,
 * `cancelled`/`unarmed` are neutral, `reset()` (settings change — the
 * operator's "I fixed the lane") clears everything, and the durable log seeds a
 * resumed session exactly once.
 *
 * Half-open recovery: an open route stays blocked for the cooldown; the first
 * {@link isOpen} check after it admits exactly ONE probe call (every other
 * concurrent call stays blocked). The probe's recorded outcome decides:
 * success closes the breaker (streak 0), a counted failure re-opens it and
 * restarts the cooldown, and a neutral outcome (`cancelled`, …) just frees the
 * probe slot. A probe that never records (e.g. discarded as `stale-mode`) is
 * abandoned after one more cooldown so the route can never wedge.
 */
export class RouteBreaker<C> {
  private readonly routeFailures = new Map<string, number>()
  private readonly breakerOpen = new Set<string>()
  /** Session ids that already recorded one `breaker` audit event (one per session). */
  private readonly breakerAudited = new Set<string>()
  /** Session ids whose durable log already seeded this process's breaker state (R3). */
  private readonly seededSessions = new Set<string>()
  private warnedBreaker = false
  /** When each open route last opened (ms, injected clock) — the cooldown anchor. */
  private readonly openedAt = new Map<string, number>()
  /** Routes with an admitted half-open probe in flight → when it was admitted. */
  private readonly probeStartedAt = new Map<string, number>()

  constructor(private readonly deps: RouteBreakerDeps<C>) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private get cooldownMs(): number {
    return this.deps.cooldownMs ?? CLASSIFIER_BREAKER_COOLDOWN_MS
  }

  /** Clear ALL breaker state (settings change / rebuild). */
  reset(): void {
    this.routeFailures.clear()
    this.breakerOpen.clear()
    this.breakerAudited.clear()
    this.seededSessions.clear()
    this.openedAt.clear()
    this.probeStartedAt.clear()
    this.warnedBreaker = false
  }

  /**
   * Gate one call on `routeKey`: `true` means blocked (breaker open). Call it
   * exactly once per call — once the cooldown has elapsed, the first check
   * admits that call as the half-open probe (returns `false`) and later
   * checks stay blocked until the probe records its outcome.
   */
  isOpen(routeKey: string): boolean {
    if (!this.breakerOpen.has(routeKey)) return false
    const now = this.now()
    const probeAt = this.probeStartedAt.get(routeKey)
    // A probe is in flight: block everyone else until it records, unless it
    // was abandoned (never recorded within one cooldown).
    if (probeAt !== undefined && now - probeAt < this.cooldownMs) return true
    if (now - (this.openedAt.get(routeKey) ?? now) < this.cooldownMs) return true
    this.probeStartedAt.set(routeKey, now)
    return false
  }

  /** Observable state of one route (pure read; never admits a probe). */
  state(routeKey: string): RouteBreakerState {
    if (!this.breakerOpen.has(routeKey)) return 'closed'
    return this.probeStartedAt.has(routeKey) ? 'half-open' : 'open'
  }

  /** Mark a route open now (cooldown anchor), clearing any in-flight probe. */
  private open(routeKey: string): void {
    this.breakerOpen.add(routeKey)
    this.openedAt.set(routeKey, this.now())
    this.probeStartedAt.delete(routeKey)
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
    this.open(routeKey)
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
    const probing = this.probeStartedAt.has(routeKey)
    if (failure === undefined) {
      this.routeFailures.set(routeKey, 0)
      // Half-open probe succeeded: close the breaker.
      if (probing) {
        this.breakerOpen.delete(routeKey)
        this.openedAt.delete(routeKey)
        this.probeStartedAt.delete(routeKey)
      }
      return
    }
    if (!this.deps.failureTags.includes(failure)) {
      // Neutral probe outcome: free the slot so the next call may probe.
      if (probing) this.probeStartedAt.delete(routeKey)
      return
    }
    if (probing) {
      // Half-open probe failed: re-open and restart the cooldown (no new
      // warn — warn-once per process — and the audit stays one per session).
      this.open(routeKey)
      this.auditOnce(sessionId, routeKey, ctx)
      return
    }
    const count = (this.routeFailures.get(routeKey) ?? 0) + 1
    this.routeFailures.set(routeKey, count)
    if (count < this.deps.threshold) return
    if (!this.breakerOpen.has(routeKey)) this.open(routeKey)
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
