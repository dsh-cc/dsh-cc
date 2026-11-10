/**
 * Pure SystemOne decision runner (design doc
 * 2026-11-02-systemone-02-decision-runtime-metering.md §"Public interface",
 * §"Execution state machine and budget order"). No Cordis, no fs, no
 * settings: every capability arrives through `createDecisionRunner(deps)`,
 * so tests run on fakes with zero real I/O.
 *
 * State machine facts pinned here (a verified TLA model backs them; a
 * deviation is a defect):
 * - one fresh UUID decisionId per run; the timeout is the total limit from
 *   run entry, covering permit, network and retry waits — never restarted
 *   per attempt;
 * - budget order per attempt: reserve global, then the optional business
 *   provider; on any rejection the other not-yet-dispatched permits settle
 *   as not-dispatched and the run returns budget;
 * - the dispatch ledger row is appended BEFORE fetch; a failed write means
 *   no fetch happens and the attempt's permits are refunded not-dispatched;
 * - entering fetch counts as an attempt, 429 included. Only 429 retries,
 *   with a fresh reserve per attempt — a permit never serves two attempts;
 * - settle is single-invocation per permit: a throwing settle keeps its
 *   last durable reserve (the run ends error) and is never re-called;
 * - valid usage settles actual even when answers are semantically
 *   malformed; invalid usage, timeout and unknown network state settle
 *   unknown and keep the full reservation;
 * - answered requires full S1-01 validation, the response model equal to the
 *   trusted actualModelId WHEN the route pins one (an unpinned route accepts
 *   any echoed model id and merely records it), usage within the capability
 *   bounds, a successful settle and a still-valid scope;
 * - caller cancellation refunds a not-yet-dispatched attempt and keeps a
 *   dispatched one at full reservation (settled unknown);
 * - ledger rows record scope/feature/versions/ids/token counts only —
 *   never API keys, baseURL, state or question text, paths, raw error
 *   bodies or model answers.
 *
 * @module @dsh-cc/systemone/decision
 */

import { SYSTEMONE_OBSERVER_REJECTED_REASON, systemoneDecide } from './client.ts'
import type { SystemOneAnswer, SystemOneAttemptObserver, SystemOneUsage } from './client.ts'
import { validateSystemOneRequest } from './validation.ts'
import { estimateDecisionInputTokens, inputHashForDecision } from './decision-hash.ts'
import type {
  DecisionBudgetPermit,
  DecisionBudgetPermitProvider,
  DecisionLedgerOutcome,
  DecisionLedgerPhase,
  DecisionLedgerReasonCode,
  DecisionLedgerRow,
  DecisionPermitOutcome,
  DecisionRequest,
  DecisionRouteIdentity,
  DecisionRouteResolution,
  DecisionRun,
  DecisionRunner,
  DecisionRunnerDeps,
  DecisionScope,
  DecisionUnavailableReason,
} from './decision-types.ts'

export * from './decision-types.ts'

const DECISION_FEATURES: ReadonlySet<string> = new Set([
  'memory-recall',
  'memory-extraction',
  'tool-discovery',
  'skill-recommendation',
  'support-triage',
  'audit-shortlist',
  'moa-context-routing',
  'moa-acceptance',
  'summary-gate',
  'reducer-gate',
])

/** Placeholder decisionId for the pathological case where the uuid dep throws. */
const UNKNOWN_DECISION_ID = 'decision-id-unavailable'

/** 429 retry clamp mirroring the settings contract (0..2, default 0 here). */
function clampMaxRetries(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.min(2, Math.max(0, Math.trunc(value)))
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Runner-level request shape check (wire fields are covered by S1-01 later). */
function isDecisionRequestShape(request: DecisionRequest): boolean {
  if (!DECISION_FEATURES.has(request.feature)) return false
  if (request.mode !== 'shadow' && request.mode !== 'active') return false
  if (!isNonEmptyString(request.routeAlias)) return false
  if (!isNonEmptyString(request.questionVersion)) return false
  if (!isNonEmptyString(request.policyVersion)) return false
  const scope: unknown = request.scope
  if (typeof scope !== 'object' || scope === null) return false
  const s = scope as Record<string, unknown>
  if (!isNonEmptyString(s.projectKey) || !isNonEmptyString(s.sessionId) || !isNonEmptyString(s.agentId)) return false
  if (typeof s.originSeq !== 'number' || !Number.isSafeInteger(s.originSeq) || s.originSeq < 0) return false
  if (!isPositiveSafeInteger(request.maxInputTokens)) return false
  const signal: unknown = request.signal
  if (typeof signal !== 'object' || signal === null || typeof (signal as { aborted?: unknown }).aborted !== 'boolean') {
    return false
  }
  return true
}

/**
 * A route is usable only with all three token bounds and maxQuestions as
 * positive safe integers, plus a well-formed optional version pin — never
 * guessed from a model name. The pin is optional: absent disables version
 * checking entirely, present must be a non-empty string ≤256 chars. Anything
 * less is unconfigured.
 */
function isUsableRoute(route: unknown): route is DecisionRouteResolution {
  if (typeof route !== 'object' || route === null) return false
  const r = route as Record<string, unknown>
  if (!isNonEmptyString(r.provider) || !isNonEmptyString(r.model) || r.model.length > 256) return false
  if (r.actualModelId !== undefined && (!isNonEmptyString(r.actualModelId) || r.actualModelId.length > 256)) return false
  if (!isNonEmptyString(r.revision) || !isNonEmptyString(r.baseURL)) return false
  if (r.apiKey !== undefined && typeof r.apiKey !== 'string') return false
  return (
    isPositiveSafeInteger(r.perRequestTokens) &&
    isPositiveSafeInteger(r.perQuestionTokens) &&
    isPositiveSafeInteger(r.maxOutputTokens) &&
    isPositiveSafeInteger(r.maxQuestions)
  )
}

/**
 * Strict usage check: mirrors the S1-01 `isTokenCount` logic from
 * validation.ts (both counters safe non-negative integers). The client
 * reports leniently parsed raw usage; only the strict form settles actual.
 */
function isStrictUsage(usage: SystemOneUsage | undefined): usage is SystemOneUsage {
  if (usage === undefined) return false
  return (
    Number.isSafeInteger(usage.input_tokens) &&
    usage.input_tokens >= 0 &&
    Number.isSafeInteger(usage.output_tokens) &&
    usage.output_tokens >= 0
  )
}

/** A permit with its single-invocation settle tracking (separate flags). */
interface TrackedPermit {
  permit: DecisionBudgetPermit
  invoked: boolean
  succeeded: boolean
}

interface TrackedAttempt {
  /** 1-based attempt number (ledger rows and the permit reserve input). */
  attemptNo: number
  globalPermit?: TrackedPermit
  businessPermit?: TrackedPermit
  /** The fetch wrapper was entered; entering fetch counts as an attempt. */
  dispatched: boolean
  /** The outcome afterDispatch established (strictly validated by the runner). */
  knownOutcome?: DecisionPermitOutcome
}

type PreflightResult = { reason: DecisionUnavailableReason } | { route: DecisionRouteResolution; inputHash: string }

export function createDecisionRunner(deps: DecisionRunnerDeps): DecisionRunner {
  return {
    identifyRoute(alias: string, scope: DecisionScope): DecisionRouteIdentity | undefined {
      try {
        if (!deps.validateScope(scope)) return undefined
        const route = deps.resolveRoute(alias, scope)
        if (!isUsableRoute(route)) return undefined
        return {
          provider: route.provider,
          model: route.model,
          revision: route.revision,
          perRequestTokens: route.perRequestTokens,
          perQuestionTokens: route.perQuestionTokens,
          maxQuestions: route.maxQuestions,
          maxOutputTokens: route.maxOutputTokens,
        }
      } catch {
        return undefined
      }
    },

    async run(request: DecisionRequest, options?: { budgetPermit?: DecisionBudgetPermitProvider }): Promise<DecisionRun> {
      let decisionId: string
      let startedAt: number
      try {
        decisionId = deps.uuid()
        startedAt = deps.now()
      } catch {
        decisionId = UNKNOWN_DECISION_ID
        startedAt = 0
      }

      // ---- per-run mutable state ----
      const attempts: TrackedAttempt[] = []
      let fetchingIndex = -1
      let vetoCause: DecisionUnavailableReason | undefined
      let settleFailed = false
      let routeResolved: DecisionRouteResolution | undefined
      let inputHash = ''
      let reasonCode: DecisionLedgerReasonCode | undefined
      let actualModel: string | null = null
      let finalReason: DecisionUnavailableReason = 'error'
      let answered: { answers: Record<string, SystemOneAnswer>; model: string; usage: SystemOneUsage } | undefined

      const scopeOk = (): boolean => {
        try {
          return Boolean(deps.validateScope(request.scope))
        } catch {
          return false
        }
      }

      const preflight = (): PreflightResult => {
        if (request.signal.aborted) return { reason: 'cancelled' }
        if (!isDecisionRequestShape(request)) return { reason: 'malformed' }
        // A forged scope is rejected before route resolution and before reserve.
        if (!scopeOk()) return { reason: 'unconfigured' }
        const route = deps.resolveRoute(request.routeAlias, request.scope)
        if (!isUsableRoute(route)) return { reason: 'unconfigured' }
        const wireCheck = validateSystemOneRequest({
          model: route.model,
          state: request.state,
          questions: request.questions,
          timeoutMs: request.timeoutMs,
        })
        if (!wireCheck.ok) return { reason: 'malformed' }
        if (Object.keys(request.questions).length > route.maxQuestions) return { reason: 'budget' }
        // Over-limit estimates are dispatch-filtered, never truncated. The
        // limit is the smaller of the caller's and the route's window.
        const estimate = estimateDecisionInputTokens(request.state, request.questions)
        if (estimate.requestTokens > Math.min(request.maxInputTokens, route.perRequestTokens)) return { reason: 'budget' }
        const questionLimit = Math.min(request.maxInputTokens, route.perQuestionTokens)
        for (const id of Object.keys(request.questions)) {
          const tokens = estimate.questionTokens[id]
          if (tokens !== undefined && tokens > questionLimit) return { reason: 'budget' }
        }
        return { route, inputHash: inputHashForDecision({ provider: route.provider, model: route.model, routeRevision: route.revision, state: request.state, questions: request.questions, questionVersion: request.questionVersion, policyVersion: request.policyVersion }) }
      }

      try {
        const pre = preflight()
        if ('reason' in pre) {
          finalReason = pre.reason
        } else {
          const route = pre.route
          routeResolved = route
          inputHash = pre.inputHash

          const reserveTokens = {
            reservedInputTokens: route.perRequestTokens,
            reservedOutputTokens: route.maxOutputTokens,
          }

          const observer: SystemOneAttemptObserver = {
            beforeDispatch: async ({ attempt, signal }): Promise<boolean> => {
              const veto = (cause: DecisionUnavailableReason): false => {
                vetoCause = cause
                return false
              }
              try {
                const track: TrackedAttempt = { attemptNo: attempt + 1, dispatched: false }
                attempts[attempt] = track
                const reserveInput = {
                  decisionId,
                  scope: { ...request.scope },
                  feature: request.feature,
                  attempt: track.attemptNo,
                  inputTokens: route.perRequestTokens,
                  outputTokens: route.maxOutputTokens,
                }
                if (!scopeOk()) return veto('unconfigured')
                if (request.signal.aborted) return veto('cancelled')
                if (signal.aborted) return veto('timeout')
                let globalPermit: DecisionBudgetPermit | undefined
                try {
                  globalPermit = await deps.reserveGlobal.reserve({ ...reserveInput, signal })
                } catch {
                  return veto('error')
                }
                if (globalPermit === undefined) return veto('budget')
                track.globalPermit = { permit: globalPermit, invoked: false, succeeded: false }
                const business = options?.budgetPermit
                if (business !== undefined) {
                  let businessPermit: DecisionBudgetPermit | undefined
                  try {
                    businessPermit = await business.reserve({ ...reserveInput, signal })
                  } catch {
                    return veto('error')
                  }
                  if (businessPermit === undefined) return veto('budget')
                  track.businessPermit = { permit: businessPermit, invoked: false, succeeded: false }
                }
                // An abort racing the reserve waits still lands before dispatch.
                if (request.signal.aborted) return veto('cancelled')
                if (signal.aborted) return veto('timeout')
                if (!(await tryAppend({ ...rowBase('reserve', track.attemptNo, 'reserved'), ...reserveTokens }))) return veto('error')
                // The dispatch record lands BEFORE fetch; a failed write means
                // no fetch happens and the permits refund not-dispatched.
                if (!(await tryAppend(rowBase('dispatch', track.attemptNo, 'dispatched')))) return veto('error')
                fetchingIndex = attempt
                return true
              } catch {
                return veto('error')
              }
            },

            afterDispatch: async ({ attempt, usage }): Promise<void> => {
              const track = attempts[attempt]
              if (track === undefined) throw new Error('decision attempt not tracked')
              // The runner applies the strict S1-01 usage check to the raw
              // envelope usage and settles actual/unknown accordingly.
              const outcome: DecisionPermitOutcome = isStrictUsage(usage) ? { kind: 'actual', usage } : { kind: 'unknown' }
              track.knownOutcome = outcome
              await settleAttempt(track, outcome)
            },
          }

          // The runner marks fetch entry itself: it owns the "dispatched" fact.
          const wrappedFetch: typeof fetch = async (input, init) => {
            const track = attempts[fetchingIndex]
            if (track !== undefined) track.dispatched = true
            return deps.fetchImpl(input, init)
          }

          // The timeout is the total from run entry; never restarted per attempt.
          const remaining = Math.floor(request.timeoutMs - Math.max(0, deps.now() - startedAt))
          if (remaining <= 0) {
            finalReason = 'timeout'
          } else {
            const result = await systemoneDecide({
              baseURL: route.baseURL,
              model: route.model,
              state: request.state,
              questions: request.questions,
              timeoutMs: remaining,
              ...(route.apiKey !== undefined ? { apiKey: route.apiKey } : {}),
              signal: request.signal,
              fetchImpl: wrappedFetch,
              maxRetries: clampMaxRetries(deps.maxRetries),
              attemptObserver: observer,
            })
            if (result.ok) {
              actualModel = result.model
              const pinnedModel = route.actualModelId
              if (pinnedModel !== undefined && result.model !== pinnedModel) {
                // Charged at actual usage, never acted on; stays exactly as
                // before (no freeze, no overrun reclassification).
                reasonCode = 'model-version-mismatch'
                finalReason = 'malformed'
              } else if (result.usage.input_tokens > route.perRequestTokens || result.usage.output_tokens > route.maxOutputTokens) {
                // Runs whenever the pin is absent or matches: the usage-bounds
                // check does not depend on model identity being pinned.
                reasonCode = 'accounting-overrun'
                finalReason = 'malformed'
              } else if (settleFailed) {
                finalReason = 'error'
              } else if (!scopeOk()) {
                // The agent switched mid-run: settled as usual, never answered.
                finalReason = 'unconfigured'
              } else {
                answered = { answers: result.answers, model: result.model, usage: result.usage }
              }
            } else if (result.failure === 'cancelled') {
              finalReason = 'cancelled'
            } else if (result.failure === 'timeout') {
              finalReason = 'timeout'
            } else if (result.failure === 'malformed') {
              finalReason = 'malformed'
            } else {
              finalReason = result.reason === SYSTEMONE_OBSERVER_REJECTED_REASON && vetoCause !== undefined ? vetoCause : 'error'
            }
          }
        }
      } catch {
        answered = undefined
        finalReason = 'error'
      }

      // ---- finally: supplement settles, then the outcome row (never throws) ----
      for (const track of attempts) {
        // Refunded when caller cancellation (or any veto) kept the attempt out
        // of fetch; after dispatch the full reservation is kept as unknown.
        const outcome: DecisionPermitOutcome = !track.dispatched ? { kind: 'not-dispatched' } : (track.knownOutcome ?? { kind: 'unknown' })
        try {
          await settleAttempt(track, outcome)
        } catch {
          // settleFailed is recorded inside settleAttempt; never escapes.
        }
      }
      if (settleFailed) {
        answered = undefined
        finalReason = 'error'
      }
      if (routeResolved !== undefined) {
        try {
          const lastAttempt = attempts.length === 0 ? 0 : attempts[attempts.length - 1]!.attemptNo
          const outcomeRow: DecisionLedgerRow = {
            ...rowBase('outcome', lastAttempt, answered !== undefined ? 'answered' : finalReason),
            ...(actualModel !== null ? { actualModel } : {}),
            ...(reasonCode !== undefined ? { reasonCode } : {}),
            ...(answered !== undefined
              ? {
                  reservedInputTokens: routeResolved.perRequestTokens,
                  reservedOutputTokens: routeResolved.maxOutputTokens,
                  actualInputTokens: answered.usage.input_tokens,
                  actualOutputTokens: answered.usage.output_tokens,
                }
              : {}),
          }
          await deps.append(outcomeRow)
        } catch {
          // A lost reporting row never changes the run result.
        }
      }

      if (answered !== undefined) {
        return { status: 'answered', answers: answered.answers, model: answered.model, usage: answered.usage, decisionId, inputHash }
      }
      return { status: 'unavailable', reason: finalReason, decisionId }

      // Hoisted single-implementation helpers (shared by the observer path and
      // the finally supplement); function declarations lift them to run scope.
      function rowBase(phase: DecisionLedgerPhase, attemptNo: number, outcome: DecisionLedgerOutcome): DecisionLedgerRow {
        const route = routeResolved as DecisionRouteResolution
        const time = deps.now()
        return {
          schemaVersion: 1,
          eventId: deps.uuid(),
          decisionId,
          attempt: attemptNo,
          phase,
          time,
          scope: { ...request.scope },
          feature: request.feature,
          mode: request.mode,
          provider: route.provider,
          requestedModel: route.model,
          actualModel: null,
          routeRevision: route.revision,
          questionVersion: request.questionVersion,
          policyVersion: request.policyVersion,
          inputHash,
          latencyMs: Math.max(0, time - startedAt),
          outcome,
        }
      }

      async function tryAppend(row: DecisionLedgerRow): Promise<boolean> {
        try {
          await deps.append(row)
          return true
        } catch {
          return false
        }
      }

      /**
       * Settle an attempt: business first then global (the reverse of
       * acquisition), each permit exactly once. A throwing permit keeps its
       * reserve, fails the run and stops the loop; never-invoked permits are
       * left for the finally. The settle row lands after the settles.
       */
      async function settleAttempt(track: TrackedAttempt, outcome: DecisionPermitOutcome): Promise<void> {
        const held = [track.businessPermit, track.globalPermit].filter((t): t is TrackedPermit => t !== undefined)
        if (held.length === 0 || held.every((t) => t.invoked)) return
        for (const tracked of held) {
          if (tracked.invoked) continue
          tracked.invoked = true
          try {
            await tracked.permit.settle(outcome)
            tracked.succeeded = true
          } catch {
            settleFailed = true
            throw new Error('decision permit settle failed')
          }
        }
        const row: DecisionLedgerRow = {
          ...rowBase('settle', track.attemptNo, outcome.kind),
          reservedInputTokens: routeResolved!.perRequestTokens,
          reservedOutputTokens: routeResolved!.maxOutputTokens,
          ...(outcome.kind === 'actual'
            ? { actualInputTokens: outcome.usage.input_tokens, actualOutputTokens: outcome.usage.output_tokens }
            : {}),
        }
        if (!(await tryAppend(row))) {
          settleFailed = true
          throw new Error('decision settle ledger row failed')
        }
      }
    },
  }
}
