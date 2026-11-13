/**
 * The asynchronous orchestration of S1-06 skill recommendation: settings gate,
 * catalog snapshot, route identity, cache key, coalesced judgment, post-await
 * revalidation, and the shadow/active publication rules.
 *
 * Design: `docs/plans/2026-11-02-systemone-06-skill-recommendation.md`
 * § "State machine, ordering, and behavior" (the eight numbered steps
 * referenced below), § "Cache, privacy, and failure table" (the failure rows),
 * § "Files and mounting" (the runner comes from the optional
 * `ctx.systemoneDecisions.forAgent(exec.agent)`; identity is re-read after every
 * await and any changed field discards the whole recommendation).
 *
 * This module is its own file (mirroring `@dsh-cc/tool-search`'s
 * `discovery-runtime.ts`, where the same split keeps `index.ts` inside the
 * repo's per-file budget). It owns no settings, no catalog access and no tool
 * registry: every host fact arrives through {@link RecommendationRuntimeDeps},
 * so the policy, the settings table and the cache stay independently testable.
 *
 * `recommend()` is TOTAL: it never throws and never rejects. Every fault maps
 * onto a {@link SkillRecommendationResult}, because the caller is a tool body
 * that must always render something for the model. Nothing it returns contains
 * a task, a metadata field or a rationale: only status, safe names, two numbers
 * and the runner's own `decisionId`s.
 *
 * @module @dsh-cc/skill-recommender/runtime
 */

import { buildEligiblePool } from './pool.ts'
import type { RecommendationCache } from './cache.ts'
import { buildRecommendationCacheKey } from './cache.ts'
import {
  SKILL_RECOMMENDATION_LANE_ALIAS,
  catalogHashOfDescriptors,
  hostRunnerResolver,
  sameIdentity,
  sameScope,
  sessionWatermarkOf,
  thresholdsOf,
} from './contract.ts'
import type { SkillRecommendationHostFace } from './contract.ts'
import {
  SKILL_RECOMMENDATION_POLICY_VERSION,
  SKILL_RECOMMENDATION_QUESTION_VERSION,
  recommendSkills,
} from './recommend.ts'
import type { RecommendationOutcome } from './recommend.ts'
import type { RecommendationSettings } from './settings.ts'
import type {
  SkillDescriptor,
  SkillRecommendationResult,
  SkillRecommendationRunner,
} from './types.ts'

/** Step 1: `mode: off` — zero runner calls, the catalog is fully available. */
const OFF: SkillRecommendationResult = {
  status: 'off',
  recommendations: [],
  decisionIds: [],
  advisory: true,
}

/** Every failure row collapses onto this result, now carrying its reason. */
function unavailable(reason: string): SkillRecommendationResult {
  return { status: 'unavailable', recommendations: [], decisionIds: [], advisory: true, reason }
}

/** The caller (or the plugin unload) left: nothing is published or loaded. */
const CANCELLED: SkillRecommendationResult = {
  status: 'cancelled',
  recommendations: [],
  decisionIds: [],
  advisory: true,
}

/** Host dependencies: every fact about the catalog arrives through these. */
export interface RecommendationRuntimeDeps {
  /** Live settings reader; `undefined` = invalid configuration (step 1 gate). */
  readonly readSettings: () => RecommendationSettings | undefined
  /** The scope's catalog, mapped to descriptors; `undefined` = no skills service. */
  readonly listCandidates: (actor: object) => Promise<readonly SkillDescriptor[] | undefined>
  /** Bound runner for the calling actor; absent is `unavailable`. */
  readonly resolveRunner?: (actor: object) => SkillRecommendationRunner | undefined
  /** Host service face the default resolver reads. */
  readonly host?: SkillRecommendationHostFace
  /** The fiber's cache, built at mount; disposed on unload. */
  readonly cache: RecommendationCache<RecommendationOutcome>
  /** Operator-facing warn sink for genuine faults, never on the hot path. */
  readonly warn?: (message: string) => void
}

/** One call: the model-supplied task plus the calling actor and cancellation. */
export interface RecommendationCallInput {
  readonly task: string
  /** The calling agent (an `Agent`); absent ⇒ no decision-service binding. */
  readonly actor?: object | undefined
  /** The caller's own cancellation signal. */
  readonly signal?: AbortSignal | undefined
}

/** The runtime face the tool wiring holds. */
export interface RecommendationRuntime {
  /** Judge one task. Total: never throws, never rejects. */
  recommend(input: RecommendationCallInput): Promise<SkillRecommendationResult>
  /** Abort in-flight judgments and clear the cache (plugin unload, rollback). */
  dispose(): void
}

/**
 * A judgment that must be thrown away because a host fact changed across an
 * await (step 6 / REQ-5). Thrown inside the cache factory so the rejection both
 * discards the run — a stale run stores nothing — and stops the remaining
 * batches; the reason survives to the caller as `unavailable`.
 */
class StaleJudgmentSignal extends Error {
  constructor() {
    super('skill-recommendation: stale judgment')
    this.name = 'StaleJudgmentSignal'
  }
}

/**
 * Create the recommendation runtime for one plugin fiber.
 * @param deps - host seams (settings, catalog, runner, cache).
 * @returns the runtime the tool body calls.
 */
export function createRecommendationRuntime(deps: RecommendationRuntimeDeps): RecommendationRuntime {
  const resolveRunner = deps.resolveRunner
    ?? (deps.host === undefined ? () => undefined : hostRunnerResolver(deps.host))

  /** Report a genuine fault once per distinct message; never on the hot path. */
  const reported = new Set<string>()
  const reportFailure = (message: string): void => {
    if (reported.has(message)) return
    reported.add(message)
    try {
      deps.warn?.(message)
    } catch {
      // A broken warn sink must not turn a judgment into a thrown tool error.
    }
  }

  /**
   * Step 6, identity half: re-read the mode, the caller scope and the FULL
   * route identity and require them unchanged across an await. Any change
   * discards the whole recommendation — never a subset of the batches.
   */
  const assertFresh = (
    snapshot: {
      readonly settings: RecommendationSettings
      readonly scope: Parameters<typeof sameScope>[0]
      readonly route: Parameters<typeof sameIdentity>[0]
      readonly originSeq: number
    },
    runner: SkillRecommendationRunner,
  ): void => {
    const settings = deps.readSettings()
    if (settings === undefined || settings.mode !== snapshot.settings.mode) {
      throw new StaleJudgmentSignal()
    }
    const scope = runner.scope(snapshot.originSeq)
    if (!sameScope(scope, snapshot.scope)) throw new StaleJudgmentSignal()
    const route = runner.identifyRoute(SKILL_RECOMMENDATION_LANE_ALIAS, scope)
    if (route === undefined || !sameIdentity(route, snapshot.route)) throw new StaleJudgmentSignal()
  }

  return {
    async recommend(input: RecommendationCallInput): Promise<SkillRecommendationResult> {
      try {
        // Step 1: settings, then the mode gate — `off` costs zero host reads.
        const settings = deps.readSettings()
        if (settings === undefined) return unavailable('settings')
        if (settings.mode === 'off') return OFF
        if (input.actor === undefined) return unavailable('unconfigured')

        const runner = resolveRunner(input.actor)
        if (runner === undefined) return unavailable('unconfigured')
        // The watermark is the persisted session seq, never `events.length`.
        const originSeq = sessionWatermarkOf(input.actor)
        if (originSeq === undefined) return unavailable('unconfigured')

        // Step 2: snapshot the catalog, then eligibility and bounds. An empty
        // pool is a valid empty recommendation, not a failure, and costs no
        // runner call.
        const descriptors = await deps.listCandidates(input.actor)
        if (descriptors === undefined) return unavailable('unconfigured')
        const pool = buildEligiblePool(descriptors, input.task, settings)
        if (pool.kind === 'unavailable') return unavailable(pool.reason)
        if (pool.items.length === 0) {
          return { status: 'recommended', recommendations: [], decisionIds: [], advisory: true, judged: 0, eligible: 0 }
        }

        // Step 3: the keyless identity. No route ⇒ no model call.
        const scope = runner.scope(originSeq)
        const route = runner.identifyRoute(SKILL_RECOMMENDATION_LANE_ALIAS, scope)
        if (route === undefined) return unavailable('unconfigured')
        const catalogHash = catalogHashOfDescriptors(descriptors)
        const snapshot = { settings, scope, route, originSeq }

        const key = buildRecommendationCacheKey({
          projectKey: scope.projectKey,
          sessionId: scope.sessionId,
          agentId: scope.agentId,
          originSeq: scope.originSeq,
          task: input.task,
          catalogHash,
          // The FULL identity and revision — all seven fields, `maxQuestions` too.
          route,
          questionVersion: SKILL_RECOMMENDATION_QUESTION_VERSION,
          policyVersion: SKILL_RECOMMENDATION_POLICY_VERSION,
          thresholds: thresholdsOf(settings),
        })

        // Steps 4–5: one coalesced judgment, every batch under ONE deadline.
        // The revalidate hook re-reads the identity after every await inside the
        // run, so an identity change between batches stops the remaining ones.
        const outcome = await deps.cache.run(
          key,
          signal => recommendSkills({
            task: input.task,
            scope,
            signal,
            mode: settings.mode === 'shadow' ? 'shadow' : 'active',
            candidates: descriptors,
            limits: settings,
            routeAlias: SKILL_RECOMMENDATION_LANE_ALIAS,
            // Capacity design §4-C2: the route's real budgets fold into the
            // effective planning limits.
            routeCaps: {
              perRequestTokens: route.perRequestTokens,
              perQuestionTokens: route.perQuestionTokens,
              maxQuestions: route.maxQuestions,
            },
            revalidate: () => assertFresh(snapshot, runner),
          }, runner),
          input.signal,
        )
        // A cancelled caller publishes nothing (REQ-4).
        if (outcome.status === 'cancelled') return CANCELLED

        const value = outcome.value
        if (value.kind === 'cancelled') return CANCELLED
        // An unavailable runner decision removes every batch, high scores
        // included; there is nothing to publish, so skip the publish gate.
        if (value.kind === 'unavailable') return unavailable(value.reason)

        // Step 6: re-read the catalog before publishing. The catalog read is
        // the last await, so the identity/mode check runs again after it, and a
        // changed hash returns unavailable WITHOUT asking the model again.
        const settled = await deps.listCandidates(input.actor)
        if (settled === undefined) return unavailable('unconfigured')
        if (catalogHashOfDescriptors(settled) !== catalogHash) return unavailable('stale')
        assertFresh(snapshot, runner)

        const decisionIds = [...value.decisionIds]
        // Step 7: shadow keeps the numbers for the audit trail only; the model
        // sees the original catalog. `active` publishes the selected set. Both
        // carry the judged/eligible counts (capacity design §4-C4).
        if (settings.mode === 'shadow') {
          return {
            status: 'shadow',
            recommendations: [],
            decisionIds,
            advisory: true,
            judged: value.judged,
            eligible: value.eligible,
          }
        }
        return {
          status: 'recommended',
          recommendations: [...value.recommendations],
          decisionIds,
          advisory: true,
          judged: value.judged,
          eligible: value.eligible,
        }
      } catch (error) {
        // A stale identity is a normal discarded judgment, not a fault.
        if (error instanceof StaleJudgmentSignal) return unavailable('stale')
        reportFailure(`skill-recommendation: judgment failed — ${error instanceof Error ? error.message : String(error)}`)
        return unavailable('error')
      }
    },

    dispose(): void {
      deps.cache.dispose()
    },
  }
}
