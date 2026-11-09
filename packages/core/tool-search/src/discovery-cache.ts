/**
 * The in-process judgment cache of S1-05 tool discovery: a bounded LRU with
 * lazy TTL expiry, plus same-key request coalescing with independent caller
 * cancellation.
 *
 * Design: `docs/plans/2026-11-02-systemone-05-tool-discovery.md`
 * § "Lifecycle, cache, and failure handling" and § "Settings". The protocol
 * this file implements is the one shared with S1-06/S1-11/S1-12 and verified in
 * `specs/tla/decision-gate-coalescing`:
 *
 * - **cache-then-coalesce**: a completed judgment is stored BEFORE waiters are
 *   woken, and an in-flight run is joined rather than duplicated;
 * - **only complete answers are cached**: a rejected run (timeout, transport
 *   error, missing route, partial batch) and an abandoned run (every waiter
 *   left) store nothing;
 * - **per-caller independent cancellation**: each waiter's own `AbortSignal`
 *   ends only that waiter's wait — nothing is published on its behalf — while
 *   the shared request keeps running for the others;
 * - **last waiter aborts the request**: the underlying factory's signal fires
 *   only when the refcount drops to zero;
 * - **post-await revalidation** stays with the caller (design step 9): this
 *   layer only guarantees that a run whose catalog/admission/identity/threshold
 *   inputs changed is a DIFFERENT key, so a stale judgment is never reused.
 *
 * The model's invariants map onto this file as `AbortOnlyWhenAllCancelled` and
 * `SettledHoldsSlot` (the refcounted {@link Flight}), `CacheCompleteOnly` (a
 * failed or abandoned run stores nothing), and `NoConsumeAfterCancel` (a
 * cancelled waiter resolves `cancelled` and publishes nothing).
 *
 * There is no persistence, no background sweep, and no timer: an expired entry
 * is discovered at read time and treated as absent.
 *
 * @module @dsh-cc/tool-search/discovery-cache
 */

import type { DiscoveryRouteIdentity } from './discovery.ts'

/**
 * Key-format version. Bumping it retires every previously stored entry without
 * having to reason about collisions with an older field order.
 */
export const DISCOVERY_CACHE_KEY_VERSION = 'tool-discovery-key-v1'

/**
 * The keyless route identity returned by `identifyRoute` (design
 * § "File responsibilities": the consumer re-reads it after every await and
 * compares all seven fields). One canonical declaration lives in the policy
 * layer; it is re-exported here so cache-key consumers need a single import.
 */
export type { DiscoveryRouteIdentity }

/**
 * Every settings threshold that shapes a judgment, camelCase (design §
 * "Settings"). These are part of the cache key because changing one changes
 * which candidates fit the window and which answers survive the thresholds.
 * The two CACHE knobs (`cacheEntries`, `cacheTtlMs`) are deliberately NOT here:
 * they govern reuse, not what a judgment means.
 */
export interface DiscoveryThresholds {
  /** Time ceiling for the whole discovery transaction. */
  readonly timeoutMs: number
  /** Per runner request, including questions and headroom. */
  readonly maxInputTokens: number
  /** Cap on the complete eligible pool. */
  readonly maxCandidates: number
  /** Candidates per runner request before window splitting. */
  readonly batchSize: number
  /** Longest query, in characters, that may be judged. */
  readonly maxQueryChars: number
  /** Combined per-field cap on the metadata sent for a candidate. */
  readonly maxMetadataChars: number
  /** Experimental relevance threshold. */
  readonly minRelevanceIndex: number
  /** Experimental direct-fit threshold. */
  readonly minDirectFit: number
  /** Upper bound on activated names. */
  readonly maxActivations: number
}

/**
 * Everything the design's § "Lifecycle, cache, and failure handling" requires
 * in the key, in one value. The host resolves `project`/`session`/`agent`, and
 * `originSeq` is the persisted session watermark (`Number(agent.session.seq)`)
 * — never `events.length` (design § "Inputs, questions, and output").
 */
export interface DiscoveryCacheKeyParts {
  /** Project key resolved by the host. */
  readonly project: string
  /** Session id. */
  readonly session: string
  /** Agent id within the session. */
  readonly agent: string
  /** Persisted sequence watermark at entry. */
  readonly originSeq: number
  /** The raw query; trimmed by {@link buildDiscoveryCacheKey}. */
  readonly query: string
  /** Hash of the full visible catalog. */
  readonly catalogHash: string
  /** Hash of the scope's admission (permission) set. */
  readonly admissionHash: string
  /** The full route identity and revision. */
  readonly route: DiscoveryRouteIdentity
  /** Question-set version (`tool-discovery-v1`). */
  readonly questionVersion: string
  /** Policy version (`tool-discovery-policy-v1`). */
  readonly policyVersion: string
  /** Every threshold that shapes the judgment. */
  readonly thresholds: DiscoveryThresholds
}

/**
 * Build the cache key for one discovery transaction.
 *
 * The fields are serialized in a fixed order as a JSON array, so a value can
 * never bleed into the next slot (a length-prefixed/escaped join would have to
 * re-derive that invariant). The query is trimmed first: `"  x  "` and `"x"`
 * describe the same judgment and must share a key.
 * @param parts - the transaction identity.
 * @returns an opaque, deterministic key string.
 */
export function buildDiscoveryCacheKey(parts: DiscoveryCacheKeyParts): string {
  const { route, thresholds } = parts
  return JSON.stringify([
    DISCOVERY_CACHE_KEY_VERSION,
    parts.project,
    parts.session,
    parts.agent,
    parts.originSeq,
    parts.query.trim(),
    parts.catalogHash,
    parts.admissionHash,
    route.provider,
    route.model,
    route.revision,
    route.perRequestTokens,
    route.perQuestionTokens,
    route.maxQuestions,
    route.maxOutputTokens,
    parts.questionVersion,
    parts.policyVersion,
    thresholds.timeoutMs,
    thresholds.maxInputTokens,
    thresholds.maxCandidates,
    thresholds.batchSize,
    thresholds.maxQueryChars,
    thresholds.maxMetadataChars,
    thresholds.minRelevanceIndex,
    thresholds.minDirectFit,
    thresholds.maxActivations,
  ])
}

/**
 * How one caller's wait ended: a complete judgment, or that caller's own
 * cancellation. A cancelled caller must activate nothing (design §
 * "Lifecycle, cache, and failure handling": cancellation is never backfilled
 * with lexical activation), so the two outcomes are distinguished here instead
 * of relying on a rejected promise.
 */
export type DiscoveryRunOutcome<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'cancelled' }

/** One waiting caller of a shared run. */
interface Waiter<T> {
  resolve(outcome: DiscoveryRunOutcome<T>): void
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
export interface DiscoveryCacheOptions<T> {
  /** Maximum stored entries; `0` disables storage entirely (settings `cache-entries`). */
  readonly maxEntries: number
  /** Entry lifetime in milliseconds; `<= 0` means no entry is ever reusable (settings `cache-ttl-ms`). */
  readonly ttlMs: number
  /**
   * Whether a completed judgment may be stored. Defaults to "only a fully
   * validated `selected` judgment": the design forbids caching timeouts,
   * cancellation, missing routes, partial batches and lexical fallbacks.
   */
  readonly cacheable?: (value: T) => boolean
  /** Clock, injectable for tests; defaults to `Date.now`. */
  readonly now?: () => number
}

/**
 * Default cacheability: a discriminated judgment is stored only when it is a
 * validated `selected` answer (design § "Lifecycle, cache, and failure
 * handling"). A non-discriminated value has no verdict to second-guess and is
 * stored. Note this is a shape test, not the validation itself: the judgment
 * layer must mint `kind: 'selected'` only after full validation.
 */
function defaultCacheable(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || !('kind' in value)) return true
  return (value as { readonly kind?: unknown }).kind === 'selected'
}

/**
 * In-process LRU cache with TTL and refcounted same-key coalescing.
 *
 * One instance per plugin fiber (design § "Lifecycle, cache, and failure
 * handling": plugin unload aborts its requests and clears the cache — call
 * {@link DiscoveryCache.clear} from the unload path). Storage is a `Map`, whose
 * iteration order is the LRU order: a read re-inserts the entry at the MRU end,
 * a write beyond `maxEntries` evicts from the front.
 */
export class DiscoveryCache<T> {
  private readonly entries = new Map<string, { readonly value: T; readonly storedAt: number }>()

  private readonly flights = new Map<string, Flight<T>>()

  private readonly maxEntries: number

  private readonly ttlMs: number

  private readonly cacheable: (value: T) => boolean

  private readonly now: () => number

  constructor(options: DiscoveryCacheOptions<T>) {
    this.maxEntries = Math.max(0, Math.trunc(options.maxEntries))
    this.ttlMs = options.ttlMs
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
   * Resolve one discovery transaction, reusing a cached judgment or joining the
   * in-flight run for the same key.
   *
   * - a warm entry is returned without invoking `factory`;
   * - concurrent callers with the same key share ONE `factory` invocation;
   * - `signal` cancels only THIS caller's wait (resolving `cancelled`, so the
   *   caller activates nothing); the shared request is aborted only when the
   *   last waiter's signal aborts;
   * - a factory rejection (timeout, transport error, partial batch) is
   *   propagated to every remaining waiter and caches nothing.
   * @param key - the key from {@link buildDiscoveryCacheKey}.
   * @param factory - performs the judgment; receives the shared abort signal.
   * @param signal - the calling transaction's own cancellation signal.
   * @returns the judgment, or `cancelled` when this caller left.
   */
  async run(
    key: string,
    factory: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<DiscoveryRunOutcome<T>> {
    const cached = this.read(key)
    if (cached !== undefined) return { status: 'ok', value: cached.value }
    if (signal?.aborted === true) return { status: 'cancelled' }
    const flight = this.flightOf(key, factory)
    return this.awaitFlight(key, flight, signal)
  }

  /**
   * Drop every stored entry and abort every in-flight run, resolving its
   * waiters as cancelled. This is the plugin-unload / rollback hook (design
   * § "Lifecycle, cache, and failure handling" and § "Release gates and
   * rollback").
   */
  clear(): void {
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
    if (this.ttlMs <= 0 || this.now() - entry.storedAt >= this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  /** Store one completed judgment, evicting the least recently used entry. */
  private store(key: string, value: T): void {
    if (this.maxEntries <= 0) return
    if (!this.cacheable(value)) return
    this.entries.delete(key)
    this.entries.set(key, { value, storedAt: this.now() })
    while (this.entries.size > this.maxEntries) {
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
    // coalescing onto it. The late settlement above caches nothing.
    this.detach(key, flight)
    if (!flight.controller.signal.aborted) flight.controller.abort()
  }

  /** Register one caller as a waiter of a flight. */
  private awaitFlight(
    key: string,
    flight: Flight<T>,
    signal: AbortSignal | undefined,
  ): Promise<DiscoveryRunOutcome<T>> {
    return new Promise<DiscoveryRunOutcome<T>>((resolve, reject) => {
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
