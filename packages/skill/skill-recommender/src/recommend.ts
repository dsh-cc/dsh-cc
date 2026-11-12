/**
 * The recommendation policy layer of S1-06: the outcome and call contract, the
 * deterministic selection order, and the one sequential runner loop.
 *
 * Everything here is plain data in, plain data out — no cordis context, no
 * settings snapshot, no cache, no catalog lookup: the runner arrives as an
 * injected argument and every bound arrives as a validated limit. The one
 * impure edge is the injected `runner.run` call in {@link recommendSkills},
 * which is why the wiring layer owns mode presentation, caching and identity
 * revalidation (§ "State machine, ordering, and behavior" steps 1, 6 and 7).
 *
 * Any incomplete or invalid batch discards the WHOLE recommendation — a high
 * score from an earlier batch is never retained (§ "State machine, ordering,
 * and behavior" step 4). Candidate eligibility, question construction, batching
 * and answer validation live in `pool.ts`, split out for the repository's
 * per-file size budget.
 *
 * Section references below are into
 * `docs/plans/2026-11-02-systemone-06-skill-recommendation.md`.
 *
 * @module @dsh-cc/skill-recommender/recommend
 */

import type {
  SkillDecisionRun,
  SkillDescriptor,
  SkillRecommendationEntry,
  SkillRecommendationRunner,
  SkillRecommendationScope,
} from './types.ts'
import {
  buildEligiblePool,
  catalogHashOf,
  planBatches,
  scoreBatch,
} from './pool.ts'
import type {
  RecommendationBatch,
  RecommendationLimits,
  RecommendationUnavailable,
  RecommendationUnavailableReason,
  ScoredSkill,
} from './pool.ts'

/** The feature this package owns on the wire (§ "Candidate eligibility"). */
export const SKILL_RECOMMENDATION_FEATURE = 'skill-recommendation'

/** Question-set version sent on the wire (§ "Candidate eligibility"). */
export const SKILL_RECOMMENDATION_QUESTION_VERSION = 'skill-recommendation-v1'

/** Policy version sent on the wire (§ "Candidate eligibility"). */
export const SKILL_RECOMMENDATION_POLICY_VERSION = 'skill-recommendation-policy-v1'

/**
 * What the pure layer decides. `unavailable` and `cancelled` discard every
 * batch; `recommended` with an empty list is a valid outcome (§ "State machine,
 * ordering, and behavior" steps 4 and 7). `decisionIds` are minted by the runner
 * that owns a decision, so this layer only relays them.
 */
export type RecommendationOutcome =
  | {
    readonly kind: 'recommended'
    readonly recommendations: readonly SkillRecommendationEntry[]
    readonly decisionIds: readonly string[]
  }
  | RecommendationUnavailable
  | { readonly kind: 'cancelled' }

/** Everything one pure recommendation call needs, minus the runner. */
export interface RecommendRequest {
  readonly task: string
  /** Metering scope produced by the bound runner, never by model parameters. */
  readonly scope: SkillRecommendationScope
  readonly signal: AbortSignal
  /**
   * Forwarded on the wire only. `off` never reaches this layer (the caller
   * returns off without a runner call), and `shadow` still computes the full
   * result — hiding it from the model context is the caller's job.
   */
  readonly mode: 'shadow' | 'active'
  /** The candidate catalog as the skill service exposes it, unmodified. */
  readonly candidates: readonly SkillDescriptor[]
  readonly limits: RecommendationLimits
  /** The decision lane alias to send; resolved by the host. */
  readonly routeAlias: string
  /**
   * The caller's identity/state gate (design § "State machine, ordering, and
   * behavior" step 6; REQ-5 of `specs/tla/decision-gate-coalescing`: "identity
   * is revalidated after every await"). Called BEFORE each batch is sent and
   * AFTER each batch's await, so an identity, mode or catalog change between
   * batches stops the remaining requests instead of wasting them. It signals a
   * stale judgment by THROWING: the throw rejects the enclosing judgment, which
   * therefore stores and publishes nothing, and the wiring layer maps it to
   * `unavailable`. Omitted in the pure policy tests, where there is no host.
   */
  readonly revalidate?: () => void
}

/** One whole-outcome unavailable result. */
function unavailable(reason: RecommendationUnavailableReason): RecommendationUnavailable {
  return { kind: 'unavailable', reason }
}

/**
 * Filter and order the scored pool (§ "State machine, ordering, and behavior"
 * step 5): keep items at or above both thresholds, order by relevance
 * descending, then prerequisite fit descending, then name ascending, and
 * truncate to `maxRecommendations`. An empty result is valid and is never
 * backfilled.
 * @param scored - every scored skill of every answered batch.
 * @param limits - the two thresholds and the result cap.
 * @returns the recommendations, in deterministic order.
 */
export function selectRecommendations(
  scored: readonly ScoredSkill[],
  limits: Pick<RecommendationLimits, 'minRelevanceIndex' | 'minPrerequisitesMet' | 'maxRecommendations'>,
): readonly SkillRecommendationEntry[] {
  const limit = Math.max(0, Math.floor(limits.maxRecommendations))
  return scored
    .filter(item =>
      item.relevance >= limits.minRelevanceIndex
      && item.prerequisitesMet >= limits.minPrerequisitesMet)
    .sort((left, right) =>
      right.relevance - left.relevance
      || right.prerequisitesMet - left.prerequisitesMet
      || left.name.localeCompare(right.name))
    .slice(0, limit)
}

/**
 * Run the complete recommendation for one task (§ "State machine, ordering, and
 * behavior").
 *
 * Order: a missing runner is `unconfigured` with zero calls; an already-aborted
 * request is `cancelled`; the pool and its bounds are resolved next; an empty
 * pool is a valid empty result with zero calls. Every batch is then requested in
 * sequence under ONE deadline, and a single failure — unavailable runner, thrown
 * transport error, malformed batch, expired deadline — discards everything
 * scored so far. High scores from an earlier batch are never retained.
 *
 * The caller owns the rest: mode presentation (`off`/`shadow`), the decision
 * cache, and re-reading the route identity and catalog after the await.
 * @param request - task, scope, mode, catalog and limits.
 * @param runner - the bound runner, or `undefined` when no service is mounted.
 * @returns the selected recommendations, or why they are unavailable.
 */
export async function recommendSkills(
  request: RecommendRequest,
  runner: SkillRecommendationRunner | undefined,
): Promise<RecommendationOutcome> {
  if (runner === undefined) return unavailable('unconfigured')
  if (request.signal.aborted) return { kind: 'cancelled' }

  const pool = buildEligiblePool(request.candidates, request.task, request.limits)
  if (pool.kind === 'unavailable') return pool

  // An empty eligible pool has nothing to judge: a valid empty recommendation,
  // not a failure, and it costs no runner call.
  if (pool.items.length === 0) return { kind: 'recommended', recommendations: [], decisionIds: [] }

  const plan = planBatches(pool.items, request.task, request.limits, catalogHashOf(pool.items))
  if (plan.kind === 'unavailable') return plan

  const deadline = Date.now() + request.limits.timeoutMs
  const deadlineController = new AbortController()
  const timer = setTimeout(() => deadlineController.abort(), Math.max(1, request.limits.timeoutMs))
  const signal = AbortSignal.any([request.signal, deadlineController.signal])
  const scored: ScoredSkill[] = []
  const decisionIds: string[] = []

  try {
    for (const [index, batch] of plan.batches.entries()) {
      // Only batches still pending can expire; the deadline is shared by all.
      if (index > 0 && Date.now() >= deadline) return unavailable('timeout')
      if (request.signal.aborted) return { kind: 'cancelled' }
      if (deadlineController.signal.aborted) return unavailable('timeout')

      // Step 6 / REQ-5: the host's identity gate closes BEFORE the request, so a
      // changed identity never spends a wire attempt.
      request.revalidate?.()

      const run = await dispatch(runner, request, batch, signal, Math.max(1, deadline - Date.now()))
      // ... and again after the await, before the answer is used at all.
      request.revalidate?.()
      if (run.status === 'unavailable') {
        return run.reason === 'cancelled' ? { kind: 'cancelled' } : unavailable(run.reason)
      }
      if (run.decisionId !== undefined) decisionIds.push(run.decisionId)

      const batchScore = scoreBatch(run.answers, batch.items)
      // One missing or invalid item discards the whole recommendation: a partial
      // judgment would claim a completeness it does not have.
      if (batchScore === undefined) return unavailable('malformed')
      scored.push(...batchScore)
    }
  } finally {
    clearTimeout(timer)
  }

  return {
    kind: 'recommended',
    recommendations: selectRecommendations(scored, request.limits),
    decisionIds,
  }
}

/**
 * Send one batch, turning a thrown transport error into the design's `error`
 * row instead of an exception. A failure that coincides with the caller's
 * cancellation is still `cancelled`, not `error`.
 * @param runner - the bound runner.
 * @param request - the enclosing call, for the shared scope and limits.
 * @param batch - the batch to judge.
 * @param signal - the combined caller/deadline signal.
 * @param timeoutMs - the remaining slice of the shared deadline.
 * @returns the runner's decision run, or an `error`/`cancelled` sentinel.
 */
async function dispatch(
  runner: SkillRecommendationRunner,
  request: RecommendRequest,
  batch: RecommendationBatch,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<SkillDecisionRun> {
  try {
    return await runner.run({
      feature: SKILL_RECOMMENDATION_FEATURE,
      mode: request.mode,
      routeAlias: request.routeAlias,
      questionVersion: SKILL_RECOMMENDATION_QUESTION_VERSION,
      policyVersion: SKILL_RECOMMENDATION_POLICY_VERSION,
      scope: request.scope,
      state: batch.state,
      questions: batch.questions,
      timeoutMs,
      maxInputTokens: request.limits.maxInputTokens,
      signal,
    })
  } catch {
    if (request.signal.aborted) return { status: 'unavailable', reason: 'cancelled' }
    return { status: 'unavailable', reason: 'error' }
  }
}
