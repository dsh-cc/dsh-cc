/**
 * The entry-point admission router (harness-0.2.2 D3.2 — replaces the
 * `agent/request` classify+overlay listener and the `system-prompt/assemble`
 * classification seam, both of which are gone: 0.2.2 freezes each step's
 * selection at `preStep` start and step-fatally rejects provider/model/effort
 * rewrites on `agent/request`, so routing moved to entry-point admission).
 *
 * `routeBeforeAdmission(agent, opening)` classifies a genuine user-turn
 * opening ONCE (pre-admission — the only seam where an awaited async
 * classification can precede the step's `model.current()` freeze) and writes
 * the tier via `agent.model.select(tierSelection)` BEFORE the caller's
 * `agent.followup(...)`. The gate (design §5.3, D3.2): route only when moa
 * is enabled AND armed AND validation passed AND the agent is the root (not
 * a subagent) AND `opening.source.kind === 'user'` (genuine user turn;
 * non-user sources — `cc-workflow-completion`, `moa-escalation`, notices —
 * never classify). Side-effect-free when disarmed.
 *
 * Fail-open (FailOpenServe, D3.2): a classification miss re-selects the
 * independently tracked `userBaseSelection` — merely skipping would leave
 * the previous turn's durable tier in force, while the model resets `tier`
 * per user turn.
 *
 * Admission→turn binding: the real turn number is only known when the loop
 * claims the admitted message, so the classification result parks in a
 * single pending slot and binds at `noteClaimed` (the `agent/inbox/claimed`
 * listener), which also restores escalation floors for retry turns (the
 * retry's MODEL is durable via the judge's pre-followup select — the floor
 * restore only feeds the judge's `fromTier` bookkeeping).
 *
 * All failures fail-open to the live selection: classification never throws,
 * and the System One result is validated structurally (error-finish, empty
 * probabilities, and the `input_tokens >= window` truncation sentinel are
 * all failure — P3b contract, never try/catch semantics alone).
 *
 * @module
 */

import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { appendJsonl, readJsonl } from '@dsh-cc/sidecar-io'
import { capMiddleToTokenBudget, systemoneDecide } from '@dsh-cc/systemone'
import { isSubagentAgent } from './agent-scope.ts'
import { moaNoticeSource } from './provenance.ts'
import {
  captureClaimed,
  noteClaimedTurn,
  queueMoaRow,
  setTurnTier,
  spliceMoaRows,
} from './runtime-state.ts'
import { restoreEscalationFloor, type OpeningSource } from './escalation-restore.ts'
import { isMoaEscalationMessage } from './state.ts'
import { collapseAppliedTier, ladderSnapshot, TIER_ALIASES, tierAt } from './tiers.ts'
import type { MoaCore } from './index.ts'
import { resolveJudgeRoute } from './judge-route.ts'
import type { ArmingValidation, EnsureArmed, RouterDeps } from './router-arming.ts'

/** Truncation marker handed to `capMiddleToTokenBudget` (head 2/3 + tail 1/3). */
const CROP_MARKER = '[…truncated…]'

/** System One connection facts for the judge route. */
// Local import indirection keeps the tier import lazy for the validation path.
export type { TierResolution } from './tiers.ts'

/** One routing decision parked between admission and the turn's claim. */
interface PendingAdmission {
  /** The exact admitted opening (bound by reference first, then text). */
  opening: UserMessage
  /** The classified tier; undefined on a fail-open (row is still logged). */
  tier: number | undefined
  /** The turnId-less sidecar row content, written with the real turn at bind. */
  row: {
    tier?: string
    argmaxTier?: string
    probabilities?: Record<string, number>
    latencyMs: number
    truncated: boolean
    failure?: string
  }
}

/** Raw sidecar row shape read back by the resume rehydration (D3.2). */
interface SidecarRow {
  type?: string
  tier?: unknown
  toTier?: unknown
  provider?: unknown
  model?: unknown
  reasoningEffort?: unknown
}

export interface RequestRouter {
  /**
   * The D3.2 admission seam: classify one genuine user-turn opening and
   * record the tier selection BEFORE the caller's `agent.followup(...)`.
   * Side-effect-free when disarmed / the opening is non-user / the agent is
   * a subagent.
   */
  routeBeforeAdmission(agent: unknown, opening: UserMessage): Promise<void>
  /**
   * The `agent/inbox/claimed` handler: per-message opening capture (judge
   * input), the pending-admission bind (turn number, route row, status row,
   * sticky tier), and the escalation-floor restore for retry turns. Returns
   * a promise settling when the bind's ledger write completed (undefined
   * when nothing bound) — production callers ignore it; rigs await it.
   */
  noteClaimed(agent: unknown, message: UserMessage, turn: number): Promise<void> | void
  /**
   * The tier's effort-validated `ModelSelection` (withTier's effort
   * re-validation moved here, D3.2): carried effort supported by the tier
   * model survives; an unsupported or unresolvable one degrades to the bare
   * pair with a warn-once status row. Shared with the judge's escalation
   * select. Undefined when the tier's route does not resolve.
   */
  tierSelection(tier: number, carriedEffort: string | undefined, signal: AbortSignal): Promise<ModelSelection | undefined>
  /** Pre-step delivery for queued status rows (mount AFTER the observe listener). */
  preStepListener(payload: unknown, next: () => Promise<unknown>): Promise<unknown>
}

export function createRequestRouter(
  core: MoaCore,
  opts: { validation: ArmingValidation; deps: RouterDeps; ensureArmed?: EnsureArmed | undefined },
): RequestRouter {
  const { arming, bookkeeping } = core
  const deps = opts.deps
  let backendWarned = false
  let routesWarned = false
  /** (provider, model, effort) triples already warned about (§3.2 warn-once). */
  /** The one classification parked between admission and claim-bind. */
  let pendingAdmission: PendingAdmission | undefined
  /** Sidecar rehydration runs at most once per router lifetime (D3.2). */
  let rehydrated = false

  const warn = (message: string): void => deps.logger?.warn(message)

  /** The tier's provider/model pair, with the unresolved-route warn-once. */
  const tierRoutePair = (tier: number): { provider: string; model: string } | undefined => {
    const pair = tierRouteVariables(tier, deps.routes?.())
    if (pair === undefined && !routesWarned) {
      routesWarned = true
      warn(`moa: tier route for "${tierAt(tier) ?? tier}" unresolved; failing open to the live selection`)
    }
    return pair
  }

  /** One side-car route record (§7 R1, mirrored as a JSONL side-car row). */
  const logRoute = async (row: {
    turnId: number
    originSeq?: number
    tier?: string; argmaxTier?: string
    probabilities?: Record<string, number>
    latencyMs: number
    truncated: boolean
    /** System One failure tag on the fail-open path. */
    failure?: string
  }): Promise<void> => {
    const path = deps.ledgerPath?.()
    if (path === undefined) return
    await appendJsonl(path, { type: 'route', ts: new Date().toISOString(), ...row })
  }

  /**
   * One System One classify for a turn's opening. Returns the (collapsed)
   * applied tier and the turnId-less sidecar row; the row is written when
   * the admission binds to its real turn at claim.
   */
  const classifyOnce = async (
    signal: AbortSignal,
    opening: UserMessage,
  ): Promise<{ tier: number | undefined; row: PendingAdmission['row'] }> => {
    const settings = deps.readSettings()
    const routes = deps.routes?.()
    const judge = resolveJudgeRoute(settings.judgeRoute, {
      modelRoutes: routes,
      budgetTokens: settings.classifyBudgetTokens,
    })
    const state = capMiddleToTokenBudget(textOf(opening), settings.classifyBudgetTokens, CROP_MARKER)
    const now = deps.now ?? Date.now
    const startedAt = now()
    const classify = async (): Promise<{ tier: number | undefined; row: PendingAdmission['row'] }> => {
      if (!judge.ok) return { tier: undefined, row: { latencyMs: now() - startedAt, truncated: false, failure: judge.reason } }
      // Resolution guarantees a model on the ok branch; if it somehow does
      // not, fail open rather than substitute a model string.
      if (judge.route.model === undefined) {
        return { tier: undefined, row: { latencyMs: now() - startedAt, truncated: false, failure: 'judge route has no model' } }
      }
      const backend = deps.resolveBackend?.(judge.route)
      if (backend === undefined) {
        if (!backendWarned) {
          backendWarned = true
          warn(`moa: no System One backend baseURL for judge route ${judge.route.provider}/${judge.route.model}; failing open`)
        }
        return { tier: undefined, row: { latencyMs: now() - startedAt, truncated: false, failure: 'no backend baseURL' } }
      }
      const result = await systemoneDecide({
        baseURL: backend.baseURL,
        ...(backend.apiKey === undefined ? {} : { apiKey: backend.apiKey }),
        // Wire model == route.model, exactly as the alias/route configured it —
        // never `${provider}/${model}` (provider-prefixing produced a 400 "not a
        // configured systemone model", live-traced 2026-10-10) and never a
        // hardcoded fallback (checked non-undefined above).
        model: judge.route.model,
        state,
        questions: { route: ROUTING_QUESTION },
        timeoutMs: settings.callBudgetMs,
        signal,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      })
      const latencyMs = now() - startedAt
      if (!result.ok) {
        return { tier: undefined, row: { latencyMs, truncated: false, failure: result.failure } }
      }
      const probabilities = result.answers.route?.probabilities
      let tier: number | undefined
      if (probabilities !== undefined) {
        // Argmax over the four tier labels only; every label must carry a
        // number (empty/missing probabilities are failure, P3b).
        let bestProbability = -Infinity
        tier = 0
        for (const [index, label] of TIER_ALIASES.entries()) {
          const p = probabilities[label]
          if (typeof p !== 'number') {
            tier = undefined
            break
          }
          if (p > bestProbability) {
            bestProbability = p
            tier = index
          }
        }
      }
      // Truncation sentinel (§3.2): the gateway silently truncates oversized
      // state; input_tokens pinning at the window means the verdict is garbage.
      const truncated = result.usage.input_tokens >= judge.window
      if (truncated) tier = undefined
      // §3.3 applied-index collapse: a same-model argmax flip is start-index
      // noise — apply/ledger the FIRST index of the contiguous run.
      const applied = tier === undefined ? undefined : collapseAppliedTier(tier, ladderSnapshot(opts.validation.ladder, routes))
      const labels = applied === undefined || tier === undefined ? {} : { tier: tierAt(applied) ?? String(applied), argmaxTier: tierAt(tier) ?? String(tier) }
      return {
        tier: applied,
        row: {
          ...labels,
          ...(probabilities === undefined ? {} : { probabilities }),
          latencyMs,
          truncated,
        },
      }
    }
    return classify()
  }

  /**
   * The effort-validated tier `ModelSelection` (withTier's effort half —
   * cache + resolveEfforts + warn-once degrade — moved to admission, D3.2).
   * The bare-pair half is the shared pure `tierRouteVariables`.
   */
  const tierSelectionFor = createEffortSelector({
    tierRoutePair,
    resolveEfforts: (provider, model, signal) => deps.resolveEfforts?.(provider, model, signal),
    queueMoaRow,
  })

  /** Field-equal full selection (route AND effort) — the FailOpenServe skip test. */
  const sameSelection = (left: ModelSelection, right: { provider: string; model: string; reasoningEffort?: string | undefined }): boolean =>
    left.provider === right.provider && left.model === right.model
    && (left.reasoningEffort ?? undefined) === (right.reasoningEffort ?? undefined)

  /**
   * FailOpenServe (D3.2): a classification miss restores the user/base pair,
   * because merely skipping the select would leave the previous turn's
   * durable tier in force. Skipped when the live selection already IS the
   * base pair (an options-only boot fallback gains no durable event).
   */
  const serveUserBase = (agent: Agent, live: ModelSelection | undefined): void => {
    const base = arming.userBaseSelection()
    if (base === undefined) return
    if (live !== undefined && sameSelection(live, base)) return
    agent.model.select({
      provider: base.provider,
      model: base.model,
      ...(base.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(base.reasoningEffort) }),
    })
  }

  /** Resolve the implied selection of one sidecar row (D3.2 rehydration). */
  const impliedSelectionOf = (row: SidecarRow | undefined): { provider: string; model: string; reasoningEffort?: string | undefined } | undefined => {
    if (row === undefined) return undefined
    if (row.type === 'user-select') {
      if (typeof row.provider !== 'string' || typeof row.model !== 'string') return undefined
      return {
        provider: row.provider,
        model: row.model,
        ...(typeof row.reasoningEffort === 'string' ? { reasoningEffort: row.reasoningEffort } : {}),
      }
    }
    if (row.type === 'route' && typeof row.tier === 'string') {
      const index = TIER_ALIASES.indexOf(row.tier)
      return index < 0 ? undefined : tierRouteVariables(index, deps.routes?.())
    }
    if (row.type === 'escalate' && typeof row.toTier === 'number') {
      return tierRouteVariables(row.toTier, deps.routes?.())
    }
    return undefined
  }

  /**
   * Resume rehydration (D3.2 provenance), once per router lifetime: read the
   * sidecar's LAST row of any kind and freshness-check its implied pair
   * against the session's durable `model/selection` state (`current()` is
   * `pending ?? lastUsed`). A matching `route`/`escalate` row rehydrates
   * `lastMoaSelection` (armed); a matching `user-select` row rehydrates
   * `userBaseSelection` with the `ModelSwitchBack` re-arm check; a missing
   * file, a torn read, or a failed freshness check (a stale row after an
   * unlogged user write — the durable select outlived the sidecar, the
   * documented crash window) falls back to conservative
   * unarmed-until-boot-pair. A session with no previous request history is
   * fresh: rehydration is a no-op for it.
   */
  const rehydrateFromSidecar = async (agent: Agent): Promise<void> => {
    if (rehydrated) return
    rehydrated = true
    try {
      if (agent.session.requestHeader() === undefined) return
      const path = deps.ledgerPath?.()
      if (path === undefined) {
        arming.rehydrateFromSidecar(undefined)
        return
      }
      const rows = await readJsonl<SidecarRow>(path)
      const last = rows.at(-1)
      const implied = impliedSelectionOf(last)
      const live = agent.model.current()
      const fresh = implied !== undefined && live !== undefined
        && implied.provider === live.provider && implied.model === live.model
      if (!fresh || last === undefined || implied === undefined) {
        arming.rehydrateFromSidecar(undefined)
        return
      }
      arming.rehydrateFromSidecar(
        last.type === 'user-select'
          ? { kind: 'user-select', selection: implied }
          : { kind: last.type === 'escalate' ? 'escalate' : 'route', selection: implied },
      )
    } catch {
      // A torn sidecar read is the crash window: conservative fallback.
      arming.rehydrateFromSidecar(undefined)
    }
  }

  /** The admission body; routeBeforeAdmission wraps it in the fail-open guard. */
  const routeAdmission = async (agentLike: unknown, opening: UserMessage): Promise<void> => {
    if (agentLike === undefined || agentLike === null || typeof agentLike !== 'object') return
    // Subagent scope: moa routes the main conversation only (agent-scope.ts).
    if (isSubagentAgent(agentLike)) return
    const agent = agentLike as Agent
    if (typeof agent.model?.current !== 'function') return
    await rehydrateFromSidecar(agent)
    // Pre-route live observation (r3-final provenance): first-wins boot
    // baseline + userBase init — UNCONDITIONAL across the enabled gate, so
    // a ship-dark session that later enables shares one baseline. moa's own
    // writes are filtered (a routed pair must not become "boot").
    const live = agent.model.current()
    const lastMoa = arming.lastMoaSelection()
    if (live !== undefined && (lastMoa === undefined || live.provider !== lastMoa.provider || live.model !== lastMoa.model)) {
      arming.noteBootPair(live)
    }
    // The §5.3/D3.2 gate, spelled inline: genuine user openings only —
    // cc-workflow-completion, moa-escalation, notices never classify.
    if (opening.source?.kind !== 'user') return
    if (!deps.readSettings().enabled) return
    if (!opts.validation.ok) opts.ensureArmed?.()
    if (!opts.validation.ok || !arming.isArmed()) return
    const signal = new AbortController().signal
    const { tier, row } = await classifyOnce(signal, opening)
    if (tier === undefined) {
      serveUserBase(agent, live)
      pendingAdmission = { opening, tier: undefined, row }
      return
    }
    // withTier's effort re-validation, moved to admission (D3.2): the
    // carried effort is the pre-route live selection's.
    const selection = await tierSelectionFor(tier, live?.reasoningEffort, signal)
    if (selection === undefined) {
      serveUserBase(agent, live)
      pendingAdmission = { opening, tier: undefined, row }
      return
    }
    agent.model.select(selection)
    arming.noteMoaSelection(selection)
    pendingAdmission = { opening, tier, row }
  }

  return {
    routeBeforeAdmission: async (agentLike: unknown, opening: UserMessage) => {
      // Top-level fail-open: admission routing never throws into the entry
      // point's prompt pipeline (the old request-listener contract).
      try {
        await routeAdmission(agentLike, opening)
      } catch (error) {
        warn(`moa: admission routing failed open (${error instanceof Error ? error.message : String(error)})`)
      }
    },

    noteClaimed: (agentLike: unknown, message: UserMessage, turn: number) => {
      // Opening capture (effective-model-truth §5.3) feeds the judge; the
      // bind + escalation bookkeeping below are subagent-guarded (capture
      // guards internally too).
      captureClaimed(agentLike, message, turn)
      noteClaimedTurn(agentLike, turn)
      if (isSubagentAgent(agentLike)) return
      // Pending-admission bind: the claim's real turn number attaches to the
      // parked classification. Reference match first, text match as the
      // fallback (the same message object normally round-trips).
      if (pendingAdmission !== undefined) {
        const admission = pendingAdmission
        if (message === admission.opening || textOf(message) === textOf(admission.opening)) {
          pendingAdmission = undefined
          const written = logRoute({ turnId: turn, ...admission.row }).catch(() => undefined)
          if (admission.tier !== undefined) {
            setTurnTier({ turn, tier: admission.tier })
            // §3.1 — a classify is NEVER silent: one row per routing decision.
            const pair = tierRoutePair(admission.tier)
            queueMoaRow(
              pair === undefined
                ? `moa: routed → ${TIER_ALIASES[admission.tier]}`
                : `moa: routed → ${TIER_ALIASES[admission.tier]} (${pair.model})`,
              admission.tier,
              pair?.model,
            )
          }
          return written
        }
      }
      // §3.4 retry-turn routing contract: NEVER re-classify a retry — the
      // retry's model is durable via the judge's pre-followup select; this
      // only restores the origin-seq floor for the judge's fromTier
      // bookkeeping (F-3, crash/resume between dispatch and retry round).
      const source = message.source
      if (!isMoaEscalationMessage(source)) return
      if (!opts.validation.ok) opts.ensureArmed?.()
      if (!deps.readSettings().enabled || !opts.validation.ok || !arming.isArmed()) return
      const floor = restoreEscalationFloor(bookkeeping, agentLike, source as OpeningSource, warn)
      if (floor === undefined) return
      // §3.5 conformance (S4): NO queued row — the typed followup the judge
      // woke IS the escalation status row.
      setTurnTier({ turn, tier: floor, suppressRow: true })
    },

    tierSelection: tierSelectionFor,

    // Pre-step delivery for queued status rows: appended to the decision's
    // messages (mcpReadyNotice.ts:161 precedent — form 'notice' + summary),
    // one row per queued notice, then pass through.
    preStepListener: async (payload: { agent?: unknown }, next) => {
      const decision = await next()
      // A subagent's pre-step never delivers the root's queued status row:
      // the Task tool that spawned the child runs during the root's turn,
      // so the child's first pre-step would otherwise win the splice — both
      // injecting a moa row into the child's transcript and silencing the
      // root's own classify notice (see agent-scope.ts). Checked BEFORE the
      // splice: a child pre-step must not drain the root's rows.
      if (isSubagentAgent(payload.agent)) return decision
      const rows = spliceMoaRows()
      if (rows.length === 0) return decision
      const shape = decision as { kind?: string; messages?: UserMessage[] }
      if (shape.kind === 'reject' || shape.messages === undefined) return decision
      return {
        ...shape,
        messages: [
          ...shape.messages,
          ...rows.map((row) =>
            createUserMessage({ content: [{ type: 'text', text: row.text }], source: moaNoticeSource(row.text, row.tier, row.model) }),
          ),
        ],
      }
    },
  }
}

import { createEffortSelector, ROUTING_QUESTION, textOf, tierRouteVariables } from './router-tiers.ts'
export { validateArming } from './router-arming.ts'
export type { ArmingValidation, EnsureArmed, MoaRouteBackend, RouterDeps } from './router-arming.ts'

export { ROUTING_QUESTION, textOf, tierRouteVariables } from './router-tiers.ts'
