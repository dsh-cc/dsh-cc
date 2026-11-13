/**
 * The structural boundary between S1-06 skill recommendation and S1-02's
 * decision runtime at wiring time: the host resolver seam, the catalog digest
 * that pins a judgment to a visible catalog, and the equality checks the
 * post-await revalidation uses.
 *
 * Design: `docs/plans/2026-11-02-systemone-06-skill-recommendation.md`
 * § "Files and mounting" (the runner comes from the optional
 * `ctx.systemoneDecisions.forAgent(exec.agent)`; the route is read with
 * `runner.identifyRoute(DECISION_LANE_ALIAS, scope)` and the full identity is
 * re-read after every await) and § "Cache, privacy, and failure table" (the
 * key already pins the identity, so this layer's revalidation only has to
 * compare).
 *
 * Everything here is declared STRUCTURALLY, exactly as
 * `@dsh-cc/tool-search`'s `discovery-contract.ts` does it: the host passes its
 * real `BoundDecisionRunner` through these seams, and this package never
 * depends on the SystemOne client. The resolver is re-declared locally rather
 * than imported from the sibling package because deep imports of another
 * package's `src` are forbidden here.
 *
 * The lane alias is NOT a setting and NOT a per-feature literal: decision
 * routes were unified on `DECISION_LANE_ALIAS` (provider/model, pin rows and
 * bounds all hang off it — S1-02 § "Amendment (2026-11-10)"), so a consumer
 * that invented its own alias name would resolve no route at all and every
 * judgment would come back `unconfigured`.
 *
 * @module @dsh-cc/skill-recommender/contract
 */

import { createHash } from 'node:crypto'
import { DECISION_LANE_ALIAS } from '@dsh-cc/systemone'
import type { RecommendationThresholds } from './cache.ts'
import type { RecommendationSettings } from './settings.ts'
import type {
  SkillRecommendationRouteIdentity,
  SkillRecommendationRunner,
  SkillRecommendationScope,
} from './types.ts'

/**
 * The decision lane every S1-06 judgment is sent on. Mirrors
 * `@dsh-cc/tool-search`'s use of the same S1-02 constant: the alias IS the
 * route, so it must never be re-spelled per feature.
 */
export const SKILL_RECOMMENDATION_LANE_ALIAS: string = DECISION_LANE_ALIAS

/**
 * The host face the default resolver reads: the optional `systemoneDecisions`
 * service mounted by S1-02's `decision-usage` plugin. Its absence is the
 * design's "missing service" row — unavailable, with no model call.
 */
export interface SkillRecommendationHostFace {
  readonly systemoneDecisions?: { forAgent(actor: object): SkillRecommendationRunner }
  readonly ccSystemoneDecisions?: { forAgent(actor: object): SkillRecommendationRunner }
  /** Optional guarded service getter (structurally cordis `ctx.get`). */
  get?(name: string): unknown
}

/** The service shape both names must carry to be usable. */
function isRunnerService(value: unknown): value is { forAgent(actor: object): SkillRecommendationRunner } {
  return typeof value === 'object' && value !== null
    && typeof (value as { forAgent?: unknown }).forAgent === 'function'
}

/**
 * The default runner resolver: read the optional host service and bind it to
 * the calling actor. Never throws — a service that refuses to bind is
 * "unavailable", not a failed tool call.
 *
 * Resolution order (mirrors the tool-search resolver, issue #359: this plugin
 * is mounted at the bundle layer, the ROOT realm, where the isolate-scoped
 * `systemoneDecisions` name may have no implementation — the root-realm bridge
 * `ccSystemoneDecisions`, published by `@dsh-cc/decision-usage` for exactly
 * such out-of-group consumers, is the production landing):
 *
 * 1. `host.get('systemoneDecisions')` — the isolated name, so in-group hosts
 *    bind their OWN tree's instance.
 * 2. `host.get('ccSystemoneDecisions')` — the root-realm bridge.
 * 3. Property fallbacks — for structural hosts without a `get` seam.
 *
 * Each step is individually guarded: a throw (an isolate name crossing realms),
 * an `undefined` result or a wrong-shaped value degrades to the NEXT step,
 * never aborts resolution.
 * @param host - the host context face (structurally the cordis context).
 * @returns the resolver the runtime holds.
 */
export function hostRunnerResolver(
  host: SkillRecommendationHostFace,
): (actor: object) => SkillRecommendationRunner | undefined {
  const viaGet = (name: string): { forAgent(actor: object): SkillRecommendationRunner } | undefined => {
    try {
      const service = host.get?.(name)
      return isRunnerService(service) ? service : undefined
    } catch {
      return undefined
    }
  }
  return (actor) => {
    const service = viaGet('systemoneDecisions')
      ?? viaGet('ccSystemoneDecisions')
      ?? (isRunnerService(host.systemoneDecisions) ? host.systemoneDecisions : undefined)
      ?? (isRunnerService(host.ccSystemoneDecisions) ? host.ccSystemoneDecisions : undefined)
    if (service === undefined) return undefined
    try {
      return service.forAgent(actor)
    } catch {
      return undefined
    }
  }
}

/** Total deterministic digest: `sha256:` over the JSON of the value. */
export function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

/**
 * The digest of the FULL scoped catalog a judgment was made from — the design's
 * "full scoped catalog hash" (§ "Cache, privacy, and failure table"). It covers
 * every visible skill, duplicates included, so a registration, an unload, a
 * description edit or a duplicate appearing all change it; the publish gate
 * re-reads the catalog and compares this value.
 * @param candidates - every candidate the scope's catalog returned.
 * @returns an opaque `sha256:…` digest.
 */
export function catalogHashOfDescriptors(
  candidates: readonly { readonly name: string; readonly description?: string; readonly whenToUse?: string; readonly source: string; readonly modelInvocable: boolean }[],
): string {
  return digest([...candidates]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(candidate => [
      candidate.name,
      candidate.description ?? null,
      candidate.whenToUse ?? null,
      candidate.source,
      candidate.modelInvocable,
    ]))
}

/**
 * The settings values that shape a judgment, camelCase, for the cache key.
 * The two CACHE knobs (`cacheEntries`, `cacheTtlMs`) are deliberately absent:
 * they govern reuse, not what a judgment means. `mode` IS present: `shadow`
 * and `active` send a different wire request, so the same task under the other
 * mode is a different judgment.
 * @param settings - the validated session settings.
 * @returns the judgment-shaping subset.
 */
export function thresholdsOf(settings: RecommendationSettings): RecommendationThresholds {
  return {
    mode: settings.mode,
    timeoutMs: settings.timeoutMs,
    maxInputTokens: settings.maxInputTokens,
    maxCandidates: settings.maxCandidates,
    batchSize: settings.batchSize,
    maxTaskChars: settings.maxTaskChars,
    maxMetadataChars: settings.maxMetadataChars,
    minRelevanceIndex: settings.minRelevanceIndex,
    minPrerequisitesMet: settings.minPrerequisitesMet,
    maxRecommendations: settings.maxRecommendations,
    minCoverage: settings.minCoverage,
  }
}

/** Whether two identities agree on ALL SEVEN fields (§ "Files and mounting"). */
export function sameIdentity(
  left: SkillRecommendationRouteIdentity,
  right: SkillRecommendationRouteIdentity,
): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.revision === right.revision
    && left.perRequestTokens === right.perRequestTokens
    && left.perQuestionTokens === right.perQuestionTokens
    && left.maxQuestions === right.maxQuestions
    && left.maxOutputTokens === right.maxOutputTokens
}

/** Whether two metering scopes agree: a different scope is a different judgment. */
export function sameScope(left: SkillRecommendationScope, right: SkillRecommendationScope): boolean {
  return left.projectKey === right.projectKey
    && left.sessionId === right.sessionId
    && left.agentId === right.agentId
    && left.originSeq === right.originSeq
}

/**
 * The persisted session watermark a judgment is anchored to: `Number(agent.
 * session.seq)` (§ "Candidate eligibility and complete state"). Deliberately
 * NOT `events.length` — the session log's `seq` is the durable watermark (the
 * same read `moa` records as its stale-result `watermark`). A host without a
 * usable watermark yields `undefined`, which the runtime reports as
 * unavailable instead of inventing a shared unknown key.
 * @param actor - the calling agent, structurally.
 * @returns the watermark, or `undefined` when the host exposes none.
 */
export function sessionWatermarkOf(actor: object): number | undefined {
  try {
    const session = (actor as { readonly session?: { readonly seq?: unknown } | undefined }).session
    const seq = Number(session?.seq)
    return Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined
  } catch {
    return undefined
  }
}
