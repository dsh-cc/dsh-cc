/**
 * The structural boundary between S1-06 skill recommendation and S1-02's
 * decision runtime, plus the recommendation service's own input and result
 * contract.
 *
 * Design: `docs/plans/2026-11-02-systemone-06-skill-recommendation.md`
 * § "Settings and tool contract" (the tool input, the descriptor and the result
 * shape), § "Candidate eligibility and complete state" (the per-item questions),
 * § "Files and mounting" (the runner comes from the optional
 * `ctx.systemoneDecisions` service; the identity is re-read after every await).
 *
 * These interfaces are declared STRUCTURALLY — exactly as `@dsh-cc/tool-search`
 * declares its discovery contract — so `@dsh-cc/skill-recommender` never takes a
 * dependency on the SystemOne client: the host passes the real
 * `BoundDecisionRunner`/`DecisionRun` through these seams unchanged. The
 * runtime, settings, cache and cordis plugin live in later slices; this file
 * holds contracts only.
 *
 * @module @dsh-cc/skill-recommender/types
 */

/** The actor a judgment is bound to: structurally an `Agent`, opaque here. */
export type SkillRecommendationActor = object

/**
 * The metering scope S1-02 binds to an actor: the host resolves project,
 * session and agent, and `originSeq` is the persisted session watermark —
 * never `events.length` (§ "Candidate eligibility and complete state").
 */
export interface SkillRecommendationScope {
  readonly projectKey: string
  readonly sessionId: string
  readonly agentId: string
  readonly originSeq: number
}

/**
 * One typed-decision question. Structurally a subset of S1-01's
 * `SystemOneQuestion`, so it can be sent without this package depending on the
 * SystemOne client.
 */
export interface SkillRecommendationQuestion {
  readonly type: 'score' | 'noul'
  readonly instructions: string
  readonly criteria?: readonly string[]
}

/**
 * One parsed answer entry. Structurally a subset of S1-01's `SystemOneAnswer`:
 * every field is optional so a partial or malformed entry is merely unusable
 * instead of a type error.
 */
export interface SkillRecommendationAnswer {
  readonly type?: 'choice' | 'score' | 'noul'
  readonly choice?: string
  readonly probabilities?: Readonly<Record<string, number>>
  readonly score?: number
  readonly noul?: number
  readonly confidence?: number
}

/** One parsed answer map, keyed by question key. */
export type SkillRecommendationAnswerMap = Readonly<Record<string, SkillRecommendationAnswer | undefined>>

/** The closed unavailable reasons of a runner decision (S1-02 contract). */
export type SkillUnavailableReason =
  | 'unconfigured'
  | 'budget'
  | 'timeout'
  | 'cancelled'
  | 'malformed'
  | 'error'

/** One runner response, structurally S1-02's `DecisionRun`. */
export type SkillDecisionRun =
  | { readonly status: 'answered'; readonly answers: SkillRecommendationAnswerMap; readonly decisionId?: string }
  | { readonly status: 'unavailable'; readonly reason: SkillUnavailableReason; readonly decisionId?: string }

/**
 * The keyless route identity returned by `identifyRoute`. The consumer re-reads
 * it after every await and compares ALL SEVEN fields: any of them changing is a
 * different judgment, so the whole recommendation is discarded (§ "Files and
 * mounting").
 */
export interface SkillRecommendationRouteIdentity {
  /** Gateway provider name. */
  readonly provider: string
  /** Model identifier as the gateway reports it (never compared against an alias). */
  readonly model: string
  /** Opaque revision/deployment marker; a bump invalidates old judgments. */
  readonly revision: string
  /** Token budget reserved for one request. */
  readonly perRequestTokens: number
  /** Token budget reserved for one question. */
  readonly perQuestionTokens: number
  /** Questions one request may carry. */
  readonly maxQuestions: number
  /** Maximum output tokens for one answer. */
  readonly maxOutputTokens: number
}

/**
 * The one request this package sends, structurally S1-02's `DecisionRequest`.
 * `state` carries ONLY the task and this batch's skill metadata — no bodies, no
 * configuration files, no history, no path-activation results.
 */
export interface SkillDecisionRequest {
  readonly feature: 'skill-recommendation'
  readonly mode: 'shadow' | 'active'
  readonly routeAlias: string
  readonly questionVersion: string
  readonly policyVersion: string
  readonly scope: SkillRecommendationScope
  readonly state: unknown
  readonly questions: Record<string, SkillRecommendationQuestion>
  readonly timeoutMs: number
  readonly maxInputTokens: number
  readonly signal: AbortSignal
}

/** The bound runner face this package consumes: S1-02's `BoundDecisionRunner`. */
export interface SkillRecommendationRunner {
  identifyRoute(alias: string, scope: SkillRecommendationScope): SkillRecommendationRouteIdentity | undefined
  scope(originSeq?: number): SkillRecommendationScope
  run(request: SkillDecisionRequest): Promise<SkillDecisionRun>
}

/**
 * The tool input (§ "Settings and tool contract"). The caller cannot pass a
 * candidate catalog, path-activation results or invocation permissions; the
 * catalog comes from the scope, and `scope` is never accepted from model
 * parameters.
 */
export interface SkillRecommendationInput {
  readonly task: string
  readonly scope: SkillRecommendationScope
  readonly signal: AbortSignal
}

/**
 * One skill as the recommendation consumer sees it.
 *
 * Two deliberate differences from the design's snippet (§ "Settings and tool
 * contract"), both approved for this package: `id` is absent because the pool
 * id is assigned locally by index (`s0`, `s1`, …) and never crosses the catalog
 * boundary, and `description`/`whenToUse` are optional because the design says
 * to omit fields that do not exist. `modelInvocable` is not part of the design
 * snippet either: the caller maps the catalog's `invocation.modelInvocable`
 * onto it, and user-invocable-only or invocation-forbidden skills never enter
 * the pool (§ "Candidate eligibility and complete state").
 */
export interface SkillDescriptor {
  readonly name: string
  readonly description?: string
  readonly whenToUse?: string
  readonly source: string
  readonly modelInvocable: boolean
}

/** One recommended skill: a name and the two numbers the judgment produced. */
export interface SkillRecommendationEntry {
  readonly name: string
  readonly relevance: number
  readonly prerequisitesMet: number
}

/**
 * The tool result (§ "Settings and tool contract"). For off, shadow,
 * unavailable and cancelled the recommendations are empty; `advisory` is
 * literally `true` because a recommendation grants no invocation eligibility.
 */
export interface SkillRecommendationResult {
  readonly status: 'off' | 'shadow' | 'recommended' | 'unavailable' | 'cancelled'
  readonly recommendations: readonly SkillRecommendationEntry[]
  readonly decisionIds: readonly string[]
  readonly advisory: true
  /**
   * How much of the eligible pool an answered prefix judged (capacity design
   * §4-C4): present on `recommended` and `shadow` results, `judged === eligible`
   * for a complete judgment.
   */
  readonly judged?: number
  /** The eligible pool size the `judged` count is a fraction of. */
  readonly eligible?: number
  /**
   * Why the judgment is unavailable, machine-readable (capacity design §4-C4):
   * the bounds/runner reasons plus the runtime's closed mapping
   * (`settings`, `unconfigured`, `stale`, `error`).
   */
  readonly reason?: string
}
