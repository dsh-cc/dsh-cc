/**
 * The `agent/request` classify listener (design §3.2, §3.4 retry-turn routing
 * contract, §6 precedence).
 *
 * Turn trigger: a NEW turn is detected by `payload.turn` DIFFERING from the
 * last seen turn — NOT by `payload.step === 0`: the harness stores phase
 * `step: 0` at turn open, then dispatches `step + 1`, so the first dispatched
 * request of a turn carries `step: 1` (grok r4, source-verified). A step===0
 * gate would never fire. Classification runs at most once per turn (on the
 * turn's first `agent/request`); every later step of the turn reuses the
 * stored tier (P1).
 *
 * §6 precedence: the arming machine observes the LIVE pre-override request
 * pair (post-`next()` resolved config, always BEFORE the `withTier` overlay
 * — via `observeLiveSelection`, see runtime-state.ts); a disarmed machine
 * (explicit `/model` this session) means zero override — including for
 * `moa-escalation` openings (explicit /model > moa overlay).
 *
 * All failures fail-open to the live selection: the listener never throws,
 * and the System One result is validated structurally (error-finish, empty
 * probabilities, and the `input_tokens >= window` truncation sentinel are
 * all failure — P3b contract, never try/catch semantics alone).
 *
 * @module
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId, type LlmCallConfig, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { ModelRoutes, ResolvedRoute } from '@dsh-cc/model-aliases'
import { appendJsonl } from '@dsh-cc/sidecar-io'
import { capMiddleToTokenBudget, systemoneDecide } from '@dsh-cc/systemone'
import { resolveJudgeRoute } from './judge-route.ts'
import { isSubagentAgent } from './agent-scope.ts'
import { moaNoticeSource } from './provenance.ts'
import {
  clearMoaRows,
  currentClaimedTurn,
  getCapturedOpening,
  getTurnTier,
  moaBootDefault,
  noteBootPair,
  observeLiveSelection,
  pairOf,
  queueMoaRow,
  sameFields,
  setTurnTier,
  spliceMoaRows,
  type TurnTier,
} from './runtime-state.ts'
import { isMoaEscalationMessage } from './state.ts'
import { collapseAppliedTier, ladderSnapshot, TIER_ALIASES, tierAt, type TierLadder } from './tiers.ts'
import type { MoaCore, MoaSettings } from './index.ts'

/** Truncation marker handed to `capMiddleToTokenBudget` (head 2/3 + tail 1/3). */
const CROP_MARKER = '[…truncated…]'

/** System One connection facts for the judge route. */
export interface MoaRouteBackend {
  baseURL: string
  apiKey?: string
}

/** Injected seams; every one is optional and degrades to fail-open. */
export interface RouterDeps {
  /** The mounting tree's OWN settings reader (§2.2.1 — never a shared capture). */
  readSettings(): MoaSettings
  /** The `ccModelRoutes` service accessor; absence fail-opens + warns once. */
  routes?: (() => ModelRoutes | undefined) | undefined
  /** System One gateway facts for a resolved judge route. */
  resolveBackend?: ((route: ResolvedRoute) => MoaRouteBackend | undefined) | undefined
  /** Advertised reasoning efforts for a concrete route (effort re-validation). */
  resolveEfforts?: (
    provider: string,
    model: string,
    signal: AbortSignal,
  ) => Promise<readonly string[] | undefined>
  /** Injectable fetch for `systemoneDecide` (tests). */
  fetchImpl?: (typeof fetch) | undefined
  /** Side-car JSONL ledger path accessor; absence disables route logging. */
  ledgerPath?: (() => string | undefined) | undefined
  logger?: { warn(message: string): void } | undefined
  now?: (() => number) | undefined
}

/** Mount-time arming validation outcome (§3.7 / §3.6 window check). */
export interface ArmingValidation { ok: boolean; reason?: string; ladder?: TierLadder | undefined; unarmedReason?: string | undefined }

/**
 * Re-run the arm/validate pass when not yet armed (mount-order race: the
 * settings / `ccModelRoutes` / alias overlay may all settle after mount).
 * Optional; the router and judge call it right before their `validation.ok`
 * gate so callback ordering can never permanently miss.
 */
export type EnsureArmed = () => void

/** Minimal structural view of the `agent/request` payload this module needs. */
export interface RequestPayload {
  agent: Pick<Agent, 'inject' | 'session'>
  turn: number
  step: number
  signal: AbortSignal
}

/**
 * Mount-time arming validation (§3.7): resolve all four tiers (four distinct
 * models) and the judge route (context window ≥ classify budget). A failure
 * leaves the feature unarmed with a warn-once — never an exception.
 */
export function validateArming(opts: {
  settings: MoaSettings
  routes?: ModelRoutes | undefined
  logger?: { warn(message: string): void } | undefined
}): ArmingValidation {
  if (opts.routes === undefined) {
    return { ok: false, reason: 'ccModelRoutes service unavailable; tiers cannot be resolved' }
  }
  const ladder = resolveTiersOf(opts.routes)
  if (!ladder.ok) return { ok: false, reason: ladder.reason }
  const judge = resolveJudgeRoute(opts.settings.judgeRoute, {
    modelRoutes: opts.routes,
    budgetTokens: opts.settings.classifyBudgetTokens,
  })
  if (!judge.ok) return { ok: false, reason: judge.reason }
  return { ok: true, ladder: ladder.tiers }
}

// Local import indirection keeps the tier import lazy for the validation path.
import { resolveTiers as resolveTiersOf, type TierResolution } from './tiers.ts'
export type { TierResolution }

export interface RequestRouter {
  listener(payload: RequestPayload, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
  /** Pre-step delivery for queued status rows (mount AFTER the observe listener). */
  preStepListener(payload: unknown, next: () => Promise<unknown>): Promise<unknown>
  /**
   * The §5.3 classification seam: an OUTER `system-prompt/assemble` listener
   * (plugin-apply registration t0 < agent creation t1). Classifies the
   * turn's opening once (sticky in runtime-state), writes the truthful
   * persona variables, and queues the status row.
   */
  assembleListener(assembly: unknown, context: unknown, next: () => Promise<unknown>): Promise<unknown>
}

export function createRequestRouter(
  core: MoaCore,
  opts: { validation: ArmingValidation; deps: RouterDeps; ensureArmed?: EnsureArmed | undefined },
): RequestRouter {
  const { arming, bookkeeping } = core
  const deps = opts.deps
  let backendWarned = false
  let routesWarned = false
  const effortCache = new Map<string, readonly string[] | undefined>()
  /** (provider, model, effort) triples already warned about (§3.2 warn-once). */
  const effortWarned = new Set<string>()

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
   * Apply the tier override AFTER `next()` (shallow copy, never in place —
   * cc-model-aliases service.ts:106-109 precedent), with effort
   * re-validation degrading exactly like `applyModelSwitch`
   * (driver-pickers.ts:98-119): unsupported carried effort → bare pair +
   * notice row. The pair half is the shared `tierRouteVariables` helper;
   * the effort half (cache + resolveEfforts + degradation row) is wire-only.
   */
  const withTier = async (
    resolved: LlmCallConfig,
    tier: number,
    signal: AbortSignal,
  ): Promise<LlmCallConfig> => {
    const pair = tierRoutePair(tier)
    if (pair === undefined) return resolved
    const carried = (resolved as { reasoningEffort?: unknown }).reasoningEffort
    if (typeof carried !== 'string' || carried.length === 0) {
      return { ...resolved, provider: pair.provider, model: pair.model }
    }
    const key = `${pair.provider}\u0000${pair.model}`
    let efforts = effortCache.get(key)
    if (efforts === undefined && !effortCache.has(key)) {
      efforts = await deps.resolveEfforts?.(pair.provider, pair.model, signal).catch(() => undefined)
      effortCache.set(key, efforts)
    }
    if (efforts !== undefined && efforts.includes(carried)) {
      return { ...resolved, provider: pair.provider, model: pair.model, reasoningEffort: ReasoningEffortId(carried) }
    }
    // Unsupported carried effort → degrade exactly like applyModelSwitch
    // (driver-pickers.ts:98-119): bare pair (drop the effort field) + notice.
    // Warn-once per (provider, model, effort): the pair is process-stable,
    // so a per-turn repeat would spam the status rows every routed turn.
    const warnKey = `${pair.provider}\u0000${pair.model}\u0000${carried}`
    if (!effortWarned.has(warnKey)) {
      effortWarned.add(warnKey)
      queueMoaRow(`Effort "${carried}" not supported by ${pair.model}; reset to default.`)
    }
    return { provider: pair.provider, model: pair.model } as LlmCallConfig
  }

  /** One System One classify for a turn's opening; undefined = fail-open. */
  const classifyOnce = async (
    turn: number,
    signal: AbortSignal,
    opening: UserMessage,
  ): Promise<number | undefined> => {
    const settings = deps.readSettings()
    const routes = deps.routes?.()
    const judge = resolveJudgeRoute(settings.judgeRoute, {
      modelRoutes: routes,
      budgetTokens: settings.classifyBudgetTokens,
    })
    if (!judge.ok) return undefined
    // Resolution guarantees a model on the ok branch; if it somehow does not,
    // fail open rather than substitute a model string.
    if (judge.route.model === undefined) return undefined
    const backend = deps.resolveBackend?.(judge.route)
    if (backend === undefined) {
      if (!backendWarned) {
        backendWarned = true
        warn(`moa: no System One backend baseURL for judge route ${judge.route.provider}/${judge.route.model}; failing open`)
      }
      return undefined
    }
    const state = capMiddleToTokenBudget(textOf(opening), settings.classifyBudgetTokens, CROP_MARKER)
    const now = deps.now ?? Date.now
    const startedAt = now()
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
      await logRoute({ turnId: turn, latencyMs, truncated: false, failure: result.failure })
      return undefined
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
    await logRoute({
      turnId: turn,
      ...labels,
      ...(probabilities === undefined ? {} : { probabilities }),
      latencyMs,
      truncated,
    })
    return applied
  }

  /**
   * Sticky per-turn classification (effective-model-truth §5.3): the FIRST
   * assembly of a turn classifies (System One, bounded by call-budget-ms);
   * later assemblies of the same turn reuse the stored tier. Escalation
   * retries (§3.4, moa-escalation provenance) skip classification and apply
   * the live origin-seq floor, suppressed from row queueing (§3.5). The
   * `gate` argument is the shared §5.3 gate the caller evaluated
   * (round-5: the retry path uses the SAME gate, not a bare isArmed()).
   */
  const tierForTurn = async (
    turn: number,
    signal: AbortSignal,
    gate: boolean,
  ): Promise<{ tier: number; classifiedNow: boolean; suppressRow: boolean } | undefined> => {
    const sticky = getTurnTier()
    if (sticky !== undefined && sticky.turn === turn) {
      return { tier: sticky.tier, classifiedNow: false, suppressRow: sticky.suppressRow === true }
    }
    const opening = getCapturedOpening(turn)
    if (opening === undefined) return undefined // capture miss: fail-open
    if (isMoaEscalationMessage(opening.source)) {
      // §3.4 retry-turn routing contract: NEVER re-classify a retry — a
      // re-classify would route the retry back to the cheap tier and make
      // escalation a no-op. Apply the live origin-seq floor instead.
      if (!gate) return undefined
      const { originSeq } = opening.source as { originSeq: number }
      const floor = bookkeeping.floorFor(originSeq)
      if (floor === undefined) return undefined
      // §3.5 conformance (S4): NO queued row — the typed followup the judge
      // woke IS the escalation status row.
      const entry: TurnTier = { turn, tier: floor, suppressRow: true }
      setTurnTier(entry)
      return { tier: floor, classifiedNow: true, suppressRow: true }
    }
    // Genuine-user gate: classify only genuine user turns.
    if (opening.source?.kind !== 'user') return undefined
    if (!opts.validation.ok) opts.ensureArmed?.()
    if (!arming.isArmed() || !opts.validation.ok) return undefined
    const tier = await classifyOnce(turn, signal, opening)
    if (tier === undefined) return undefined
    setTurnTier({ turn, tier })
    return { tier, classifiedNow: true, suppressRow: false }
  }

  return {
    listener: async (payload, next) => {
      // 1. Fast bail: the §3.1 zero-overhead default-off contract — still zero
      // classification and zero overlay, but the boot baseline is ALWAYS
      // captured (effective-model-truth §5.2 part 1; ship-dark sessions that
      // later enable share one baseline).
      if (!deps.readSettings().enabled) {
        const resolved = await next()
        if (!isSubagentAgent(payload.agent)) observeLiveSelection(pairOf(resolved))
        return resolved
      }
      // 2. Subagent scope: moa routes the main conversation only. A spawned
      // agent's model comes from its declared alias (resolved by the spawn
      // path into agentOptions), so its requests pass through unclassified
      // and unoverridden (see agent-scope.ts).
      if (isSubagentAgent(payload.agent)) return next()
      // 3+4. Always-on arming observe (effective-model-truth §5.2 part 3):
      // the resolved pair is PRE-overlay by construction (withTier runs
      // strictly after), so the old header self-feedback trap is
      // structurally impossible. Idempotent; every request.
      const resolved = await next()
      if (!isSubagentAgent(payload.agent)) observeLiveSelection(pairOf(resolved))
      // 5. The transition guard. When this clause skips withTier, clear the
      // pending rows: the queue is untagged by design, and a row advertising
      // a tier that was not applied is a lie (effective-model-truth §5.2).
      if (!arming.isArmed() || !opts.validation.ok) {
        clearMoaRows()
        return resolved
      }
      // 6. The sticky tier comes from the assemble seam's runtime-state
      // store; a classification miss fails open (serve the selection).
      const sticky = getTurnTier()
      if (sticky !== undefined && sticky.turn === payload.turn) {
        return withTier(resolved, sticky.tier, payload.signal)
      }
      return resolved
    },
    assembleListener: async (_assembly: unknown, context: unknown, next) => {
      const assembled = (await next()) as { variables?: Record<string, unknown> } | undefined
      if (assembled === undefined) return assembled
      const agent = (context as { agent?: unknown } | undefined)?.agent
      const selectionVars = pairOf(assembled.variables) // the harness's just-written selection pair
      // The session's FIRST assembly notes the boot pair directly from the
      // harness-written variables (effective-model-truth §5.2 caller (c)).
      if (agent !== undefined && !isSubagentAgent(agent) && selectionVars !== undefined) {
        noteBootPair(selectionVars)
      }
      if (!opts.validation.ok) opts.ensureArmed?.()
      // The shared §5.3 gate: classify gate AND persona gate, evaluated once,
      // so the persona and the wire cannot disagree about WHETHER an overlay
      // applies. Fail-open: the persona states the selection.
      const boot = moaBootDefault()
      const gate =
        deps.readSettings().enabled &&
        opts.validation.ok &&
        agent !== undefined &&
        !isSubagentAgent(agent) &&
        selectionVars !== undefined &&
        boot !== undefined &&
        sameFields(selectionVars, boot)
      if (!gate) return assembled
      const turn = currentClaimedTurn()
      if (turn === undefined) return assembled
      const signal =
        (context as { signal?: AbortSignal } | undefined)?.signal ?? new AbortController().signal
      const decision = await tierForTurn(turn, signal, gate)
      if (process.env.MOA_DEBUG) console.log('MOA_DEBUG decision', JSON.stringify(decision), 'turn', turn)
      if (decision === undefined) return assembled
      const pair = tierRoutePair(decision.tier)
      // §3.1 — a classify is NEVER silent: once per routing decision; the
      // escalation retries keep their suppression (§3.5 single-row).
      if (decision.classifiedNow && !decision.suppressRow) {
        queueMoaRow(
          pair === undefined
            ? `moa: routed → ${TIER_ALIASES[decision.tier]}`
            : `moa: routed → ${TIER_ALIASES[decision.tier]} (${pair.model})`,
          decision.tier,
          pair?.model,
        )
      }
      // Persona writes provider/model ONLY — never effort (§5.3, round-5).
      return { ...assembled, variables: { ...assembled.variables, ...tierRouteVariables(decision.tier, deps.routes?.()) } }
    },
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

/** The moa-local 4-way routing question (criteria ported from the P4 corpus probe). */
export const ROUTING_QUESTION = {
  type: 'choice',
  instructions: 'Classify the user request into the LOWEST capability tier that can fully handle it.',
  criteria: {
    sketch: 'trivial: typo fixes, one-line edits, simple factual questions, renames, single-command explanations',
    draft: 'moderate: single-function utilities, small localized feature edits, explaining short code snippets',
    blueprint: 'complex: multi-file or multi-module design, architecture proposals, root-cause analysis of subtle bugs, phased refactors',
    masterplan:
      'very hard or ambiguous: cross-cutting strategy, long-horizon multi-team planning, organization-scale tradeoff decisions, platform migrations',
  },
} as const

/** Plain-text projection of a message's text blocks. */
export function textOf(message: UserMessage): string {
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n')
}

/**
 * The SHARED PURE pair helper (effective-model-truth §5.3): the tier's
 * provider/model from the resolved route — synchronous, no cache access, no
 * notice queueing. Consumed by BOTH the wire's `withTier` (pair half) and
 * the assemble seam's persona variables, so the persona and the wire get
 * the identical pair.
 */
export function tierRouteVariables(
  tier: number,
  routes?: { resolve: (alias: string | undefined) => ResolvedRoute | undefined } | undefined,
): { provider: string; model: string } | undefined {
  const alias = tierAt(tier)
  const route = alias === undefined ? undefined : routes?.resolve(alias)
  if (route === undefined || route.provider === undefined || route.model === undefined) return undefined
  return { provider: route.provider as string, model: route.model as string }
}
