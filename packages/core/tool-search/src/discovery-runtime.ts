/**
 * The asynchronous orchestration of S1-05 tool discovery: settings gate, pool
 * snapshot, route identity, cache key, sequential batch execution, post-await
 * revalidation, and the shadow/active publication rules.
 *
 * Design: `docs/plans/2026-11-02-systemone-05-tool-discovery.md`
 * § "File responsibilities", § "Inputs, questions, and output",
 * § "Deterministic execution order" (the ten numbered steps referenced below),
 * § "Lifecycle, cache, and failure handling" (the shadow/active fallback table).
 *
 * This module is its own file (an approved deviation from the design's file
 * table, which names only the policy, settings and cache modules): the
 * orchestration is a state machine of its own size and `index.ts` sits at the
 * repo's per-file budget. It owns no registry, no settings and no cache state —
 * every host fact arrives through {@link DiscoveryRuntimeDeps}, so the policy,
 * the settings table and the cache stay independently testable. The structural
 * S1-02 faces and the snapshot digests live in `discovery-contract.ts`.
 *
 * `evaluate()` is TOTAL: it never throws and never rejects. Every fault maps
 * onto a {@link DiscoveryEvaluation}, because the caller is a tool body that
 * must always render something for the model.
 *
 * @module @dsh-cc/tool-search/discovery-runtime
 */

import { DECISION_LANE_ALIAS } from '@dsh-cc/systemone'
import {
  TOOL_DISCOVERY_POLICY_VERSION,
  TOOL_DISCOVERY_QUESTION_VERSION,
  buildEligiblePool,
  buildQuestions,
  expectedScore,
  planBatches,
  selectNames,
} from './discovery.ts'
import type { DeferredEntry, DiscoveryScoredItem, DiscoverySettings } from './discovery.ts'
import { buildDiscoveryCacheKey } from './discovery-cache.ts'
import type { DiscoveryCache, DiscoveryRunOutcome } from './discovery-cache.ts'
import {
  admissionHashOf,
  catalogHashOf,
  hostRunnerResolver,
  sameIdentity,
  sameScope,
  thresholdsOf,
} from './discovery-contract.ts'
import type {
  DiscoveryActor,
  DiscoveryAnswerMap,
  DiscoveryHostFace,
  DiscoveryRunner,
  DiscoveryScope,
} from './discovery-contract.ts'

/**
 * Why the feature made no judgment and the original lexical path ran (§
 * "Lifecycle, cache, and failure handling": one row per reason).
 *
 * - `off` — `mode: off`: zero runner calls.
 * - `exact` — the trimmed query names a visible admitted candidate (step 2);
 *   shadow keeps the original lexical result.
 * - `shadow` — a complete shadow judgment was tallied; the caller executes the
 *   original lexical hits.
 * - `bounds` — the pool or a group broke a hard bound (steps 4 and 5): the
 *   judgment is abandoned as a whole, never truncated.
 * - `unavailable` — no actor, no runner, no route, or the runner refused
 *   (budget, unconfigured, transport error): steps 1 and 6.
 * - `stale` — the route identity, scope, settings mode, catalog or admission
 *   changed across an await (steps 6 and 9): the judgment is discarded.
 * - `incomplete` — a batch answered without a usable answer for every question,
 *   or the shared deadline was spent: nothing partial is published.
 * - `invalid` — the settings section is invalid: no runner call (§ "Settings").
 */
export type DiscoveryFallbackReason =
  | 'off'
  | 'exact'
  | 'shadow'
  | 'bounds'
  | 'unavailable'
  | 'stale'
  | 'incomplete'
  | 'invalid'

/**
 * What one evaluation decided. `selected` means "activate exactly these names,
 * in this order" — the design's `DiscoveryResult.selected` minus `decisionIds`,
 * because the runner that owns a decision mints those and this package keeps no
 * second decision ledger. `cancelled` means the caller left: no activation of
 * any kind and no lexical backfill (§ "Lifecycle, cache, and failure handling").
 */
export type DiscoveryEvaluation =
  | { readonly kind: 'selected'; readonly names: readonly string[] }
  | { readonly kind: 'lexical'; readonly reason: DiscoveryFallbackReason }
  | { readonly kind: 'cancelled' }

/**
 * A complete, fully validated judgment: the ONLY value the cache stores. It
 * holds the scored candidates rather than the caller's final name list, because
 * `max_results` is deliberately NOT part of the cache key — each waiter applies
 * its own cap at publish time (§ "Lifecycle, cache, and failure handling").
 */
export interface DiscoveryJudgment {
  readonly kind: 'selected'
  readonly scored: readonly DiscoveryScoredItem[]
}

/**
 * In-memory shadow counters (§ "Release gates and rollback": shadow accumulates
 * hit-set differences and counts — never queries, candidate names or answers).
 */
export interface DiscoveryShadowCounters {
  /** Complete judgments tallied. */
  readonly judgments: number
  /** Judgments whose suggested set differed from the lexical hit set. */
  readonly differing: number
  /** Names suggested but not among the lexical hits. */
  readonly suggestedOnly: number
  /** Lexical hits the judgment did not suggest. */
  readonly lexicalOnly: number
}

/**
 * Host dependencies: every fact about the registry arrives through these.
 * `S` is the calling scope token the host uses to address its deferred layers
 * (a `ScopeKey` for the tool-search registry); this module never interprets it.
 */
export interface DiscoveryRuntimeDeps<S = unknown> {
  /** Live settings reader; `undefined` = invalid configuration (step 1 gate). */
  readonly readSettings: () => DiscoverySettings | undefined
  /** Scope-visible deferred snapshot with lexical scores (steps 3 and 9). */
  readonly snapshotEntries: (query: string, scope: S | undefined) => readonly DeferredEntry[]
  /** Bound runner for the calling actor; absent is `unavailable`. */
  readonly resolveRunner?: (actor: DiscoveryActor) => DiscoveryRunner | undefined
  /** Host service face the default resolver reads. */
  readonly host?: DiscoveryHostFace
  /** The fiber's cache, built from the settings table at mount; cleared on unload. */
  readonly cache: DiscoveryCache<DiscoveryJudgment>
  /** Operator-facing warn sink for genuine faults, never on the hot path. */
  readonly warn?: (message: string) => void
  /** Clock, injectable for tests; defaults to `Date.now`. */
  readonly now?: () => number
}

/** One evaluation request: the caller's query, cap, actor and cancellation. */
export interface DiscoveryEvaluateInput<S = unknown> {
  readonly query: string
  readonly maxResults: number
  /** The calling actor (an `Agent`); absent ⇒ no decision-service binding. */
  readonly actor?: DiscoveryActor | undefined
  /** The calling registry scope whose deferred layers are judged. */
  readonly scope?: S | undefined
  /** The caller's own cancellation signal. */
  readonly signal?: AbortSignal | undefined
  /** The lexical hit names, for the shadow tally only. */
  readonly lexicalNames: readonly string[]
}

/** The runtime face the tool wiring holds. */
export interface DiscoveryRuntime<S = unknown> {
  /** Judge one query. Total: never throws (§ module note). */
  evaluate(input: DiscoveryEvaluateInput<S>): Promise<DiscoveryEvaluation>
  /** Shadow counters snapshot (in-memory, counts only). */
  shadow(): DiscoveryShadowCounters
  /** Clear the cache and abort in-flight runs (plugin unload, rollback). */
  clear(): void
}

/** Everything one transaction pinned at entry, compared again at publish. */
interface TransactionSnapshot<S> {
  readonly settings: DiscoverySettings
  readonly query: string
  readonly scope: DiscoveryScope
  readonly route: Parameters<typeof sameIdentity>[1]
  readonly catalogHash: string
  readonly admissionHash: string
  /** The caller's registry scope, forwarded to the snapshot accessor. */
  readonly registryScope: S | undefined
}

/**
 * Why a judgment was abandoned mid-flight. Thrown inside the cache factory so
 * the rejection discards the run — a failed or abandoned run stores nothing —
 * and the reason survives to the caller (§ "Lifecycle, cache, and failure
 * handling").
 */
class DiscoveryFallbackSignal extends Error {
  /** Explicit assignment, not a parameter property: keeps the module loadable by Node's strip-only TypeScript mode (the eval script imports it directly). */
  readonly reason: Exclude<DiscoveryFallbackReason, 'off' | 'exact' | 'shadow' | 'invalid'>
  constructor(reason: Exclude<DiscoveryFallbackReason, 'off' | 'exact' | 'shadow' | 'invalid'>) {
    super(`tool-discovery: ${reason}`)
    this.name = 'DiscoveryFallbackSignal'
    this.reason = reason
  }
}

/** The caller (or the last waiter) left: no activation, no second request. */
class DiscoveryCancelledSignal extends Error {
  constructor() {
    super('tool-discovery: cancelled')
    this.name = 'DiscoveryCancelledSignal'
  }
}

const CANCELLED: DiscoveryEvaluation = { kind: 'cancelled' }

/**
 * Read a caller's cancellation state. A helper (not an inline comparison) so
 * the value is re-read after every await instead of being narrowed away by an
 * earlier guard.
 * @param signal - the caller's signal, if any.
 * @returns whether the caller has already left.
 */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * Read the direct-fit answer for one candidate. S1-01 already validated the
 * envelope; a missing, non-`noul`, non-finite or out-of-range value makes the
 * batch unusable (§ "Lifecycle, cache, and failure handling").
 * @param answers - the answered map.
 * @param id - the candidate id; the `_direct` question is read.
 * @returns the direct-fit value, or `undefined` when it is not usable.
 */
function directFitOf(answers: DiscoveryAnswerMap, id: string): number | undefined {
  const answer = answers[`${id}_direct`]
  if (answer === undefined) return undefined
  if (answer.type !== undefined && answer.type !== 'noul') return undefined
  const noul = answer.noul
  if (noul === undefined || !Number.isFinite(noul) || noul < 0 || noul > 1) return undefined
  return noul
}

/**
 * Read the relevance expected value for one candidate and bound it to the
 * rubric: a value outside the 0..4 index range names no rubric row, so it is
 * unusable rather than merely extreme.
 * @param answers - the answered map.
 * @param id - the candidate id.
 * @returns the expected value, or `undefined` when unusable.
 */
function relevanceOf(answers: DiscoveryAnswerMap, id: string): number | undefined {
  const score = expectedScore(answers, id)
  if (score === undefined || score < 0 || score > 4) return undefined
  return score
}

/**
 * Create the discovery runtime for one plugin fiber.
 * @param deps - host seams (settings, registry snapshot, runner, cache).
 * @returns the runtime the tool body calls.
 */
export function createDiscoveryRuntime<S>(deps: DiscoveryRuntimeDeps<S>): DiscoveryRuntime<S> {
  const now = deps.now ?? Date.now
  const resolveRunner = deps.resolveRunner ?? (deps.host === undefined ? () => undefined : hostRunnerResolver(deps.host))
  const counters = { judgments: 0, differing: 0, suggestedOnly: 0, lexicalOnly: 0 }

  /** Report a genuine fault once per distinct message; never on the hot path. */
  const reported = new Set<string>()
  const reportFailure = (message: string): void => {
    if (reported.has(message)) return
    reported.add(message)
    try {
      deps.warn?.(message)
    } catch {
      // A broken warn sink must not turn a lexical fallback into a failure.
    }
  }

  /**
   * Steps 6 and 9: re-read settings mode, scope and the full route identity and
   * require them unchanged across an await. Any change discards the whole
   * judgment — never a subset of the batches.
   */
  const assertFresh = (snapshot: TransactionSnapshot<S>, runner: DiscoveryRunner): void => {
    const settings = deps.readSettings()
    if (settings === undefined || settings.mode !== snapshot.settings.mode) {
      throw new DiscoveryFallbackSignal('stale')
    }
    const scope = runner.scope()
    if (!sameScope(scope, snapshot.scope)) throw new DiscoveryFallbackSignal('stale')
    const route = runner.identifyRoute(DECISION_LANE_ALIAS, scope)
    if (route === undefined || !sameIdentity(route, snapshot.route)) {
      throw new DiscoveryFallbackSignal('stale')
    }
  }

  /** Step 9: the catalog and admission hashes must still describe the pool. */
  const assertSamePool = (snapshot: TransactionSnapshot<S>): void => {
    const settings = deps.readSettings()
    if (settings === undefined || settings.mode !== snapshot.settings.mode) {
      throw new DiscoveryFallbackSignal('stale')
    }
    const entries = deps.snapshotEntries(snapshot.query, snapshot.registryScope)
    const pool = buildEligiblePool(entries, snapshot.query, snapshot.settings)
    if (pool.kind !== 'pool') throw new DiscoveryFallbackSignal('stale')
    if (catalogHashOf(pool.candidates) !== snapshot.catalogHash) throw new DiscoveryFallbackSignal('stale')
    if (admissionHashOf(pool.candidates, entries) !== snapshot.admissionHash) {
      throw new DiscoveryFallbackSignal('stale')
    }
  }

  /**
   * The cache factory: plan, dispatch the batches SEQUENTIALLY under one shared
   * deadline, validate every answer, then select (steps 5–8).
   */
  const judge = async (
    snapshot: TransactionSnapshot<S>,
    runner: DiscoveryRunner,
    entries: readonly DeferredEntry[],
    signal: AbortSignal,
  ): Promise<DiscoveryJudgment> => {
    const settings = snapshot.settings
    const pool = buildEligiblePool(entries, snapshot.query, settings)
    if (pool.kind !== 'pool') throw new DiscoveryFallbackSignal('bounds')
    const plan = planBatches(pool.candidates, settings.batchSize, snapshot.route, snapshot.query)
    if (plan.kind !== 'batches') throw new DiscoveryFallbackSignal('bounds')

    // One transaction deadline across ALL batches: `timeout-ms` is the ceiling
    // for the whole judgment, not a per-request budget (§ "Settings").
    const deadline = now() + settings.timeoutMs
    const scored: DiscoveryScoredItem[] = []
    for (const batch of plan.batches) {
      if (signal.aborted) throw new DiscoveryCancelledSignal()
      assertFresh(snapshot, runner)
      const remaining = deadline - now()
      // Refusing to start the next batch is the design's "no partial results".
      if (remaining <= 0) throw new DiscoveryFallbackSignal('incomplete')

      const run = await runner.run({
        feature: 'tool-discovery',
        mode: settings.mode === 'shadow' ? 'shadow' : 'active',
        routeAlias: DECISION_LANE_ALIAS,
        questionVersion: TOOL_DISCOVERY_QUESTION_VERSION,
        policyVersion: TOOL_DISCOVERY_POLICY_VERSION,
        scope: snapshot.scope,
        state: { query: snapshot.query, candidates: batch },
        questions: buildQuestions(batch),
        // The remaining budget, not the full timeout: the ceiling is shared, and
        // one logical wire attempt per batch (429 retries belong to S1-02).
        timeoutMs: remaining,
        maxInputTokens: settings.maxInputTokens,
        signal,
      })
      // Revalidate after EVERY await, before the answer is used at all.
      assertFresh(snapshot, runner)
      if (run.status === 'unavailable') {
        if (run.reason === 'cancelled') throw new DiscoveryCancelledSignal()
        throw new DiscoveryFallbackSignal('unavailable')
      }
      for (const candidate of batch) {
        const scoreIndex = relevanceOf(run.answers, candidate.id)
        const noul = directFitOf(run.answers, candidate.id)
        // One unusable answer discards the whole judgment: no partial publish.
        if (scoreIndex === undefined || noul === undefined) {
          throw new DiscoveryFallbackSignal('incomplete')
        }
        scored.push({ id: candidate.id, name: candidate.name, scoreIndex, noul, lexicalScore: candidate.lexicalScore })
      }
    }
    return { kind: 'selected', scored }
  }

  /** Shadow: count the suggested-vs-lexical difference; persist nothing. */
  const tally = (suggested: readonly string[], lexical: readonly string[]): void => {
    counters.judgments += 1
    const suggestedSet = new Set(suggested)
    const lexicalSet = new Set(lexical)
    const suggestedOnly = suggested.filter(name => !lexicalSet.has(name)).length
    const lexicalOnly = lexical.filter(name => !suggestedSet.has(name)).length
    if (suggestedOnly + lexicalOnly > 0) counters.differing += 1
    counters.suggestedOnly += suggestedOnly
    counters.lexicalOnly += lexicalOnly
  }

  /**
   * Run the judgment through the cache, honoring the § "Settings" rule that
   * `cache-entries: 0` / `cache-ttl-ms: 0` disable reuse: the judgment still
   * runs, but nothing may be stored, so it bypasses the shared flight.
   */
  const runJudgment = async (
    settings: DiscoverySettings,
    key: string,
    factory: (signal: AbortSignal) => Promise<DiscoveryJudgment>,
    signal: AbortSignal | undefined,
  ): Promise<DiscoveryRunOutcome<DiscoveryJudgment>> => {
    if (settings.cacheEntries > 0 && settings.cacheTtlMs > 0) return deps.cache.run(key, factory, signal)
    if (aborted(signal)) return { status: 'cancelled' }
    const controller = new AbortController()
    const forward = (): void => controller.abort()
    signal?.addEventListener('abort', forward, { once: true })
    try {
      const value = await factory(controller.signal)
      // The caller may have left while the shared request was still running.
      return aborted(signal) ? { status: 'cancelled' } : { status: 'ok', value }
    } finally {
      signal?.removeEventListener('abort', forward)
    }
  }

  /** One transaction: route, pool, key, cache, publish (§ steps 1–9). */
  const runTransaction = async (
    settings: DiscoverySettings,
    input: DiscoveryEvaluateInput<S>,
    runner: DiscoveryRunner,
    entries: readonly DeferredEntry[],
  ): Promise<DiscoveryEvaluation> => {
    const scope = runner.scope()
    const route = runner.identifyRoute(DECISION_LANE_ALIAS, scope)
    // No keyless identity ⇒ no judgment and no model call (§ "File
    // responsibilities": "undefined falls back directly").
    if (route === undefined) return { kind: 'lexical', reason: 'unavailable' }
    const pool = buildEligiblePool(entries, input.query, settings)
    if (pool.kind !== 'pool') return { kind: 'lexical', reason: 'bounds' }

    const snapshot: TransactionSnapshot<S> = {
      settings,
      query: input.query,
      scope,
      route,
      catalogHash: catalogHashOf(pool.candidates),
      admissionHash: admissionHashOf(pool.candidates, entries),
      registryScope: input.scope,
    }
    const key = buildDiscoveryCacheKey({
      project: scope.projectKey,
      session: scope.sessionId,
      agent: scope.agentId,
      originSeq: scope.originSeq,
      query: input.query,
      catalogHash: snapshot.catalogHash,
      admissionHash: snapshot.admissionHash,
      // The FULL identity and revision — all seven fields, `maxQuestions` too.
      route,
      questionVersion: TOOL_DISCOVERY_QUESTION_VERSION,
      policyVersion: TOOL_DISCOVERY_POLICY_VERSION,
      thresholds: thresholdsOf(settings),
    })

    const outcome = await runJudgment(settings, key, signal => judge(snapshot, runner, entries, signal), input.signal)
    if (outcome.status === 'cancelled') return CANCELLED
    // Step 9, after the (possibly shared) await: catalog, admission and mode.
    try {
      assertSamePool(snapshot)
    } catch {
      return { kind: 'lexical', reason: 'stale' }
    }
    // Each waiter caps the shared judgment with its OWN `max_results`
    // (`min(max_results, max-activations)`, step 8).
    const names = selectNames(outcome.value.scored, snapshot.settings, input.maxResults)
    if (snapshot.settings.mode === 'shadow') {
      tally(names, input.lexicalNames)
      return { kind: 'lexical', reason: 'shadow' }
    }
    return { kind: 'selected', names }
  }

  return {
    async evaluate(input: DiscoveryEvaluateInput<S>): Promise<DiscoveryEvaluation> {
      try {
        // Step 1: settings, then the mode gate — `off` costs zero runner calls.
        const settings = deps.readSettings()
        if (settings === undefined) return { kind: 'lexical', reason: 'invalid' }
        if (settings.mode === 'off') return { kind: 'lexical', reason: 'off' }

        const entries = deps.snapshotEntries(input.query, input.scope)
        // Step 2: an exact name match needs no model. `active` activates only
        // that exact name; `shadow` keeps the original lexical result, adding no
        // exact-name rule the original code does not have.
        const trimmed = input.query.trim()
        const exact = trimmed.length === 0
          ? undefined
          : entries.find(entry =>
            entry.name === trimmed && entry.admitted && !entry.activated && !entry.alwaysLoad)
        if (exact !== undefined) {
          return settings.mode === 'active'
            ? { kind: 'selected', names: [exact.name] }
            : { kind: 'lexical', reason: 'exact' }
        }

        if (input.actor === undefined) return { kind: 'lexical', reason: 'unavailable' }
        const runner = resolveRunner(input.actor)
        if (runner === undefined) return { kind: 'lexical', reason: 'unavailable' }

        return await runTransaction(settings, input, runner, entries)
      } catch (error) {
        if (error instanceof DiscoveryCancelledSignal) return CANCELLED
        if (error instanceof DiscoveryFallbackSignal) return { kind: 'lexical', reason: error.reason }
        // A fault in the judgment path is a lexical fallback, never a failed
        // search: the model still gets its original ToolSearch result.
        reportFailure(`tool-discovery: judgment failed — ${error instanceof Error ? error.message : String(error)}`)
        return { kind: 'lexical', reason: 'unavailable' }
      }
    },
    shadow(): DiscoveryShadowCounters {
      return { ...counters }
    },
    clear(): void {
      deps.cache.clear()
    },
  }
}
