/**
 * The structural boundary between tool discovery and S1-02's decision runtime:
 * the request/response faces it consumes, the host resolver seam, and the two
 * snapshot digests that pin a judgment to a catalog and an admission set.
 *
 * Design: `docs/plans/2026-11-02-systemone-05-tool-discovery.md`
 * § "File responsibilities" (the runner comes from the optional
 * `ctx.systemoneDecisions` service; re-read the identity after every await and
 * compare all fields), § "Inputs, questions, and output", § "Lifecycle, cache,
 * and failure handling" (what the cache key pins).
 *
 * These interfaces are declared STRUCTURALLY — exactly as `discovery.ts`
 * declares the question and answer shapes — so `@dsh-cc/tool-search` never takes
 * a dependency on the SystemOne client: the host passes its real
 * `BoundDecisionRunner`/`DecisionRun` through these seams unchanged.
 *
 * @module @dsh-cc/tool-search/discovery-contract
 */

import { createHash } from 'node:crypto'
import type {
  DeferredEntry,
  DiscoveryAnswer,
  DiscoveryCandidate,
  DiscoveryQuestion,
  DiscoveryRouteIdentity,
  DiscoverySettings,
} from './discovery.ts'
import type { DiscoveryThresholds } from './discovery-cache.ts'

/** The actor a judgment is bound to: structurally an `Agent`, opaque here. */
export type DiscoveryActor = object

/**
 * The metering scope S1-02 binds to an actor: the host resolves project,
 * session and agent, and `originSeq` is the persisted session watermark —
 * never `events.length` (§ "Inputs, questions, and output").
 */
export interface DiscoveryScope {
  readonly projectKey: string
  readonly sessionId: string
  readonly agentId: string
  readonly originSeq: number
}

/** One parsed answer map, keyed by question key. */
export type DiscoveryAnswerMap = Readonly<Record<string, DiscoveryAnswer | undefined>>

/** The closed unavailable reasons of a runner decision (S1-02 contract). */
export type DiscoveryUnavailableReason =
  | 'unconfigured'
  | 'budget'
  | 'timeout'
  | 'cancelled'
  | 'malformed'
  | 'error'

/** One runner response, structurally S1-02's `DecisionRun`. */
export type DiscoveryDecisionRun =
  | { readonly status: 'answered'; readonly answers: DiscoveryAnswerMap; readonly decisionId?: string }
  | { readonly status: 'unavailable'; readonly reason: DiscoveryUnavailableReason; readonly decisionId?: string }

/**
 * The one request this layer sends, structurally S1-02's `DecisionRequest`.
 * `state` carries ONLY the query and this batch's candidate metadata — no tool
 * callbacks, credentials, parameter schemas or message history.
 */
export interface DiscoveryDecisionRequest {
  readonly feature: 'tool-discovery'
  readonly mode: 'shadow' | 'active'
  readonly routeAlias: string
  readonly questionVersion: string
  readonly policyVersion: string
  readonly scope: DiscoveryScope
  readonly state: unknown
  readonly questions: Record<string, DiscoveryQuestion>
  readonly timeoutMs: number
  readonly maxInputTokens: number
  readonly signal: AbortSignal
}

/** The bound runner face this layer consumes: S1-02's `BoundDecisionRunner`. */
export interface DiscoveryRunner {
  identifyRoute(alias: string, scope: DiscoveryScope): DiscoveryRouteIdentity | undefined
  scope(originSeq?: number): DiscoveryScope
  run(request: DiscoveryDecisionRequest): Promise<DiscoveryDecisionRun>
}

/**
 * The host face the default resolver reads: the optional `systemoneDecisions`
 * service mounted by S1-02's `decision-usage` plugin. Its absence is the
 * design's "runner missing" row — a lexical fallback with no model call.
 */
export interface DiscoveryHostFace {
  readonly systemoneDecisions?: { forAgent(actor: DiscoveryActor): DiscoveryRunner }
}

/**
 * The default runner resolver: read the optional host service and bind it to
 * the calling actor. Never throws — a service that refuses to bind is
 * "unavailable", not a failed search.
 * @param host - the host context face (structurally the cordis context).
 * @returns the resolver handed to `createDiscoveryRuntime`.
 */
export function hostRunnerResolver(
  host: DiscoveryHostFace,
): (actor: DiscoveryActor) => DiscoveryRunner | undefined {
  return (actor) => {
    try {
      return host.systemoneDecisions?.forAgent(actor)
    } catch {
      return undefined
    }
  }
}

/** Total deterministic digest: `sha256:` over the JSON of the value. */
function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

/** Name-ascending order, the id order {@link buildEligiblePool} assigns. */
function byName(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name.localeCompare(right.name)
}

/**
 * `catalogHash` — the approved resolution of the design's underspecified
 * "catalog hash": `sha256` over the sorted `(name, description, searchHint)`
 * triples of the eligible pool. A registration, an unload, or a description
 * edit changes it, which invalidates every cached judgment (§ "Lifecycle,
 * cache, and failure handling": "Candidate activation, registration, unload, or
 * a limit change alters the key").
 * @param candidates - the eligible pool.
 * @returns an opaque `sha256:…` digest.
 */
export function catalogHashOf(candidates: readonly DiscoveryCandidate[]): string {
  return digest([...candidates].sort(byName).map(candidate => [candidate.name, candidate.description, candidate.searchHint ?? null]))
}

/**
 * `admissionHash` — the approved resolution of the design's underspecified
 * "admission hash": `sha256` over the sorted `(name, isAdmitted)` pairs of the
 * pool. The pool only holds admitted entries, so this pins the permission
 * verdict the judgment was made under; a restriction applied during the
 * judgment changes the pool and discards it at step 9.
 * @param candidates - the eligible pool.
 * @param entries - the snapshot the pool was built from (the verdict source).
 * @returns an opaque `sha256:…` digest.
 */
export function admissionHashOf(
  candidates: readonly DiscoveryCandidate[],
  entries: readonly DeferredEntry[],
): string {
  const admitted = new Map(entries.map(entry => [entry.name, entry.admitted]))
  return digest([...candidates].sort(byName).map(candidate => [candidate.name, admitted.get(candidate.name) === true]))
}

/**
 * The judgment-shaping thresholds, camelCase, for the cache key (§ "Settings").
 * The two cache knobs are deliberately absent: they govern reuse, not what a
 * judgment means.
 */
export function thresholdsOf(settings: DiscoverySettings): DiscoveryThresholds {
  return {
    timeoutMs: settings.timeoutMs,
    maxInputTokens: settings.maxInputTokens,
    maxCandidates: settings.maxCandidates,
    batchSize: settings.batchSize,
    maxQueryChars: settings.maxQueryChars,
    maxMetadataChars: settings.maxMetadataChars,
    minRelevanceIndex: settings.minRelevanceIndex,
    minDirectFit: settings.minDirectFit,
    maxActivations: settings.maxActivations,
  }
}

/** Whether two identities agree on ALL SEVEN fields (§ "File responsibilities"). */
export function sameIdentity(left: DiscoveryRouteIdentity, right: DiscoveryRouteIdentity): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.revision === right.revision
    && left.perRequestTokens === right.perRequestTokens
    && left.perQuestionTokens === right.perQuestionTokens
    && left.maxQuestions === right.maxQuestions
    && left.maxOutputTokens === right.maxOutputTokens
}

/** Whether two metering scopes agree: a different scope is a different judgment. */
export function sameScope(left: DiscoveryScope, right: DiscoveryScope): boolean {
  return left.projectKey === right.projectKey
    && left.sessionId === right.sessionId
    && left.agentId === right.agentId
    && left.originSeq === right.originSeq
}
