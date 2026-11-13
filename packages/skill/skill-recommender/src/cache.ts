/**
 * The in-process judgment cache of S1-06 skill recommendation: a bounded LRU
 * with lazy TTL expiry, plus same-key request coalescing with independent
 * caller cancellation.
 *
 * Design: `docs/plans/2026-11-02-systemone-06-skill-recommendation.md`
 * § "Cache, privacy, and failure table" and § "State machine, ordering, and
 * behavior". The protocol this file implements is the one shared with
 * S1-05/S1-11/S1-12 and verified in `specs/tla/decision-gate-coalescing`
 * (REQ-1..REQ-6); it is a deliberate structural mirror of
 * `@dsh-cc/tool-search`'s `discovery-cache.ts`, re-declared here because deep
 * imports of another package's `src` are forbidden:
 *
 * - **cache-then-coalesce** (REQ-1): a completed judgment is stored BEFORE
 *   waiters are woken, and an in-flight run is joined rather than duplicated;
 * - **only complete answers are cached** (REQ-3): a rejected run (timeout,
 *   transport error, missing route, incomplete batch) and an abandoned run
 *   (every waiter left) store nothing;
 * - **per-caller independent cancellation** (REQ-2, REQ-4): each waiter's own
 *   `AbortSignal` ends only that waiter's wait — nothing is published on its
 *   behalf — while the shared request keeps running for the others, and the
 *   shared request is aborted only when the refcount drops to zero;
 * - **post-await revalidation stays with the caller** (REQ-5): this layer only
 *   guarantees that a run whose catalog/identity/threshold inputs changed is a
 *   DIFFERENT key, so a stale judgment is never reused.
 *
 * The model's invariants map onto this file as `AbortOnlyWhenAllCancelled` and
 * `SettledHoldsSlot` (the refcounted {@link Flight}), `CacheCompleteOnly` (a
 * failed or abandoned run stores nothing), `NoConsumeAfterCancel` (a cancelled
 * waiter resolves `cancelled` and publishes nothing) and `ValidAtConsume` (the
 * key pins the identity, the runtime revalidates at publish).
 *
 * There is no persistence, no background sweep and no timer: an expired entry
 * is discovered at read time and treated as absent. Nothing a caller sends is
 * ever written to disk here — the design forbids persisting the task or the
 * candidate metadata.
 *
 * @module @dsh-cc/skill-recommender/cache
 */

import { createHash } from 'node:crypto'
import type { SkillRecommendationRouteIdentity } from './types.ts'

/**
 * Key-format version. Bumping it retires every previously stored entry without
 * having to reason about collisions with an older field order.
 */
export const RECOMMENDATION_CACHE_KEY_VERSION = 'skill-recommendation-key-v1'

/**
 * The task field of the key, as the design words it ("task hash"). Hashing
 * rather than embedding keeps the caller's own words out of a key string; the
 * task is trimmed first so `"  x  "` and `"x"` describe the same judgment and
 * share one entry.
 * @param task - the raw recommendation task.
 * @returns an opaque `sha256:…` digest of the trimmed task.
 */
function taskHashOf(task: string): string {
  return `sha256:${createHash('sha256').update(task.trim()).digest('hex')}`
}

/**
 * Every settings value that shapes a judgment, camelCase. These are part of the
 * cache key because changing one changes which candidates fit the window, which
 * answers survive the thresholds, or (for `mode`) what the wire request says.
 * The two CACHE knobs (`cacheEntries`, `cacheTtlMs`) are deliberately NOT here:
 * they govern reuse, not what a judgment means.
 */
export interface RecommendationThresholds {
  /** `shadow` and `active` send a different wire request. */
  readonly mode: 'off' | 'shadow' | 'active'
  /** Time ceiling shared by every batch. */
  readonly timeoutMs: number
  /** Per runner request, including state, questions and headroom. */
  readonly maxInputTokens: number
  /** Cap on the complete eligible pool. */
  readonly maxCandidates: number
  /** Skills per runner request. */
  readonly batchSize: number
  /** Longest task, in characters, that may be judged. */
  readonly maxTaskChars: number
  /** Combined per-item cap on `description` plus `whenToUse`. */
  readonly maxMetadataChars: number
  /** Relevance threshold. */
  readonly minRelevanceIndex: number
  /** Prerequisite threshold. */
  readonly minPrerequisitesMet: number
  /** Upper bound on returned recommendations. */
  readonly maxRecommendations: number
  /** Deadline-partial coverage floor; `1` is the original completeness rule. */
  readonly minCoverage: number
}

/**
 * Everything the design's § "Cache, privacy, and failure table" requires in the
 * key, in one value: project, session, agent, originSeq, the task hash, the full
 * scoped catalog hash, the full route identity and revision, both version
 * strings and the judgment-shaping settings.
 */
export interface RecommendationCacheKeyParts {
  /** Project key resolved by the host. */
  readonly projectKey: string
  /** Session id. */
  readonly sessionId: string
  /** Agent id within the session. */
  readonly agentId: string
  /** Persisted session watermark at entry (`Number(agent.session.seq)`). */
  readonly originSeq: number
  /** The raw task; trimmed and hashed by {@link buildRecommendationCacheKey}. */
  readonly task: string
  /** Digest of the FULL scoped catalog the judgment covers. */
  readonly catalogHash: string
  /** The full route identity and revision (all seven fields). */
  readonly route: SkillRecommendationRouteIdentity
  /** Question-set version (`skill-recommendation-v1`). */
  readonly questionVersion: string
  /** Policy version (`skill-recommendation-policy-v1`). */
  readonly policyVersion: string
  /** Every settings value that shapes the judgment, `mode` included. */
  readonly thresholds: RecommendationThresholds
}

/**
 * Build the cache key for one recommendation judgment.
 *
 * The fields are serialized in a fixed order as a JSON array, so a value can
 * never bleed into the next slot. The task enters the key as a hash of its
 * trimmed text ({@link taskHashOf}): `"  x  "` and `"x"` describe the same
 * judgment and must share a key, and the caller's own words are not held in a
 * key string.
 * @param parts - the judgment identity.
 * @returns an opaque, deterministic key string.
 */
export function buildRecommendationCacheKey(parts: RecommendationCacheKeyParts): string {
  const { route, thresholds } = parts
  return JSON.stringify([
    RECOMMENDATION_CACHE_KEY_VERSION,
    parts.projectKey,
    parts.sessionId,
    parts.agentId,
    parts.originSeq,
    taskHashOf(parts.task),
    parts.catalogHash,
    route.provider,
    route.model,
    route.revision,
    route.perRequestTokens,
    route.perQuestionTokens,
    route.maxQuestions,
    route.maxOutputTokens,
    parts.questionVersion,
    parts.policyVersion,
    thresholds.mode,
    thresholds.timeoutMs,
    thresholds.maxInputTokens,
    thresholds.maxCandidates,
    thresholds.batchSize,
    thresholds.maxTaskChars,
    thresholds.maxMetadataChars,
    thresholds.minRelevanceIndex,
    thresholds.minPrerequisitesMet,
    thresholds.maxRecommendations,
    thresholds.minCoverage,
  ])
}

/**
 * How one caller's wait ended: a complete judgment, or that caller's own
 * cancellation. A cancelled caller must publish nothing (REQ-4), so the two
 * outcomes are distinguished here instead of relying on a rejected promise.
 */
export type RecommendationRunOutcome<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'cancelled' }

/** The cache's live size limits (read per operation, never frozen). */
export interface RecommendationCacheLimits {
  /** Maximum stored entries; `0` disables storage entirely (`cache-entries`). */
  readonly maxEntries: number
  /** Entry lifetime in milliseconds; `<= 0` means no entry is ever reusable (`cache-ttl-ms`). */
  readonly ttlMs: number
}

/** One waiting caller of a shared run. */
interface Waiter<T> {
  resolve(outcome: RecommendationRunOutcome<T>): void
  reject(error: unknown): void
}

/** One in-flight run shared by every waiter with the same key. */
interface Flight<T> {
  /** Aborts the underlying factory once the LAST waiter leaves. */
  readonly controller: AbortController
  readonly waiters: Set<Waiter<T>>
  settled: boolean
}

/** Cache construction options. */
export interface RecommendationCacheOptions<T> {
  /**
   * The live limits, read on every operation: `cache-entries` and `cache-ttl-ms`
   * are session settings, so a mid-session change takes effect on the next call
   * instead of requiring a remount.
   */
  readonly limits: () => RecommendationCacheLimits
  /**
   * Whether a completed judgment may be stored. Defaults to "only a fully
   * validated `recommended` outcome": the design forbids caching timeouts,
   * cancellation, unavailable runner decisions and partial batches.
   */
  readonly cacheable?: (value: T) => boolean
  /** Clock, injectable for tests; defaults to `Date.now`. */
  readonly now?: () => number
}

/**
 * Default cacheability: only a discriminated `recommended` outcome is stored
 * (design § "Cache, privacy, and failure table": "only complete, validated
 * answers are cached"). A non-discriminated value has no verdict to
 * second-guess and is stored. This is a shape test, not the validation itself:
 * the policy layer mints `recommended` only after every batch validated.
 */
function defaultCacheable(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || !('kind' in value)) return true
  const candidate = value as { readonly kind?: unknown; readonly judged?: unknown; readonly eligible?: unknown }
  if (candidate.kind !== 'recommended') return false
  // Capacity design §4-C3-6: a deadline-partial outcome is NEVER cached — REQ-3
  // ("partial results never enter the cache") and the timing-dependence of a
  // partial both demand a fresh judgment on the next call.
  return candidate.judged === undefined || candidate.eligible === undefined
    || candidate.judged === candidate.eligible
}

/**
 * In-process LRU cache with TTL and refcounted same-key coalescing.
 *
 * One instance per plugin fiber (design: plugin unload aborts its requests and
 * clears the cache — the unload path calls {@link RecommendationCache.dispose}).
 * Storage is a `Map`, whose iteration order is the LRU order: a read re-inserts
 * the entry at the MRU end, a write beyond `maxEntries` evicts from the front.
 */
export class RecommendationCache<T> {
  private readonly entries = new Map<string, { readonly value: T; readonly storedAt: number }>()

  private readonly flights = new Map<string, Flight<T>>()

  private readonly limits: () => RecommendationCacheLimits

  private readonly cacheable: (value: T) => boolean

  private readonly now: () => number

  constructor(options: RecommendationCacheOptions<T>) {
    this.limits = options.limits
    this.cacheable = options.cacheable ?? defaultCacheable
    this.now = options.now ?? Date.now
  }

  /** Stored entries currently held (expired ones are dropped as they are read). */
  get size(): number {
    return this.entries.size
  }

  /** Keys with an in-flight shared run. */
  get pending(): number {
    return this.flights.size
  }

  /**
   * Resolve one judgment, reusing a cached answer or joining the in-flight run
   * for the same key.
   *
   * - a warm entry is returned without invoking `factory`;
   * - concurrent callers with the same key share ONE `factory` invocation
   *   (REQ-1);
   * - `signal` cancels only THIS caller's wait (resolving `cancelled`, so the
   *   caller publishes nothing); the shared request is aborted only when the
   *   last waiter's signal aborts (REQ-2);
   * - a factory rejection (timeout, transport error, incomplete batch) is
   *   propagated to every remaining waiter and caches nothing (REQ-3).
   * @param key - the key from {@link buildRecommendationCacheKey}.
   * @param factory - performs the judgment; receives the shared abort signal.
   * @param signal - the calling call's own cancellation signal.
   * @returns the judgment, or `cancelled` when this caller left.
   */
  async run(
    key: string,
    factory: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<RecommendationRunOutcome<T>> {
    const cached = this.read(key)
    if (cached !== undefined) return { status: 'ok', value: cached.value }
    if (signal?.aborted === true) return { status: 'cancelled' }
    const flight = this.flightOf(key, factory)
    return this.awaitFlight(key, flight, signal)
  }

  /**
   * Drop every stored entry and abort every in-flight run, resolving its
   * waiters as cancelled. This is the plugin-unload / rollback hook (design
   * § "Cache, privacy, and failure table": "plugin unload aborts all requests
   * and clears the cache").
   */
  dispose(): void {
    this.entries.clear()
    for (const [key, flight] of [...this.flights]) {
      this.flights.delete(key)
      flight.settled = true
      if (!flight.controller.signal.aborted) flight.controller.abort()
      for (const waiter of [...flight.waiters]) {
        flight.waiters.delete(waiter)
        waiter.resolve({ status: 'cancelled' })
      }
    }
  }

  /** A warm, unexpired entry, promoted to the MRU end. */
  private read(key: string): { readonly value: T } | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    // Lazy expiry: no timer, no sweep — an expired entry is absent on read.
    const { ttlMs } = this.limits()
    if (ttlMs <= 0 || this.now() - entry.storedAt >= ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  /** Store one completed judgment, evicting the least recently used entry. */
  private store(key: string, value: T): void {
    const { maxEntries } = this.limits()
    if (maxEntries <= 0) return
    if (!this.cacheable(value)) return
    this.entries.delete(key)
    this.entries.set(key, { value, storedAt: this.now() })
    while (this.entries.size > maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) return
      this.entries.delete(oldest.value)
    }
  }

  /** The flight for a key, starting one when this caller is the first. */
  private flightOf(key: string, factory: (signal: AbortSignal) => Promise<T>): Flight<T> {
    const existing = this.flights.get(key)
    if (existing !== undefined) return existing
    const flight: Flight<T> = { controller: new AbortController(), waiters: new Set<Waiter<T>>(), settled: false }
    this.flights.set(key, flight)
    this.start(key, flight, factory)
    return flight
  }

  /** Invoke the factory once and settle the flight when it finishes. */
  private start(key: string, flight: Flight<T>, factory: (signal: AbortSignal) => Promise<T>): void {
    let started: Promise<T>
    try {
      started = factory(flight.controller.signal)
    } catch (error) {
      // A factory that throws synchronously is a failed run like any other.
      started = Promise.reject(error)
    }
    // The rejection is always handled here, so an abandoned run whose factory
    // aborts and then rejects never surfaces as an unhandled rejection.
    void started.then(
      value => this.complete(key, flight, value),
      error => this.fail(key, flight, error),
    )
  }

  /** Store (when allowed), then wake every remaining waiter with the value. */
  private complete(key: string, flight: Flight<T>, value: T): void {
    this.detach(key, flight)
    flight.settled = true
    // A run that lost its last waiter was aborted; it is never cached, even if
    // the factory resolved anyway.
    if (!flight.controller.signal.aborted) this.store(key, value)
    for (const waiter of [...flight.waiters]) {
      flight.waiters.delete(waiter)
      waiter.resolve({ status: 'ok', value })
    }
  }

  /** Propagate a failed run to every remaining waiter; nothing is cached. */
  private fail(key: string, flight: Flight<T>, error: unknown): void {
    this.detach(key, flight)
    flight.settled = true
    for (const waiter of [...flight.waiters]) {
      flight.waiters.delete(waiter)
      waiter.reject(error)
    }
  }

  /** Forget the flight for a key, leaving a newer one in place if it replaced this. */
  private detach(key: string, flight: Flight<T>): void {
    if (this.flights.get(key) === flight) this.flights.delete(key)
  }

  /** Remove one waiter, aborting the shared request when it was the last. */
  private leave(key: string, flight: Flight<T>, waiter: Waiter<T>): void {
    flight.waiters.delete(waiter)
    if (flight.settled || flight.waiters.size > 0) return
    // Last waiter gone: nothing can publish this run, so abort it and stop
    // coalescing onto it. A later settlement stores and publishes nothing.
    this.detach(key, flight)
    if (!flight.controller.signal.aborted) flight.controller.abort()
  }

  /** Register one caller as a waiter of a flight. */
  private awaitFlight(
    key: string,
    flight: Flight<T>,
    signal: AbortSignal | undefined,
  ): Promise<RecommendationRunOutcome<T>> {
    return new Promise<RecommendationRunOutcome<T>>((resolve, reject) => {
      let settled = false
      const unwatch = (): void => signal?.removeEventListener('abort', onAbort)
      const onAbort = (): void => {
        if (settled) return
        settled = true
        // THIS caller leaves; the judgment continues for the other waiters.
        this.leave(key, flight, waiter)
        resolve({ status: 'cancelled' })
      }
      const waiter: Waiter<T> = {
        resolve: (outcome) => {
          if (settled) return
          settled = true
          unwatch()
          resolve(outcome)
        },
        reject: (error) => {
          if (settled) return
          settled = true
          unwatch()
          reject(error)
        },
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      flight.waiters.add(waiter)
      // The signal may have aborted between the pre-check and the listener
      // registration; an already-aborted signal never fires the event.
      if (signal?.aborted === true) onAbort()
    })
  }
}
