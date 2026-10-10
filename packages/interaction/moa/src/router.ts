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
 * Input: the opening message from the PRE-STEP capture — never session
 * history. Retry turns (opening carries `moa-escalation` provenance) skip
 * classification entirely and apply the live origin-seq tier floor (§3.4).
 *
 * §6 precedence: the arming machine observes the LIVE pre-override request
 * pair (session request header, which moa never writes) FIRST; a disarmed
 * machine (explicit `/model` this session) means zero override — including
 * for `moa-escalation` openings (explicit /model > moa overlay).
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
import { moaNoticeSource } from './provenance.ts'
import { isMoaEscalationMessage } from './state.ts'
import { TIER_ALIASES, tierAt } from './tiers.ts'
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
  /** The pre-step capture read (never session history, §3.2). */
  getCapturedOpening(turnId: number): UserMessage | undefined
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
export interface ArmingValidation {
  ok: boolean
  reason?: string
}

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
  return { ok: true }
}

// Local import indirection keeps the tier import lazy for the validation path.
import { resolveTiers as resolveTiersOf, type TierResolution } from './tiers.ts'
export type { TierResolution }

/** The routing decision for one turn. */
interface Decision {
  tier: number
  /** Status-row text (§3.1: a classify is NEVER silent). */
  row: string
  /** True for moa-escalation openings: NO router-side queued row — the typed
   * followup the judge woke IS the escalation status row (§3.5 single-row). */
  suppressRow?: boolean
}

export interface RequestRouter {
  listener(payload: RequestPayload, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
  /** Pre-step delivery for queued status rows (mount AFTER the capture). */
  preStepListener(payload: unknown, next: () => Promise<unknown>): Promise<unknown>
  /** The decided tier for a turn, or undefined (escalation slice seam). */
  tierFor(turnId: number): number | undefined
}

export function createRequestRouter(
  core: MoaCore,
  opts: { validation: ArmingValidation; deps: RouterDeps; ensureArmed?: EnsureArmed | undefined },
): RequestRouter {
  const { arming, bookkeeping } = core
  const deps = opts.deps
  let backendWarned = false
  let routesWarned = false
  // Turn state: single slot per §3.2 (critic r5). `lastSeenTurn` drives the
  // turn-change trigger; `turnTier` holds the whole-turn override.
  let lastSeenTurn: number | undefined
  let turnTier: { turn: number; tier: number } | undefined
  /** The provider/model pair moa last applied (arming self-feedback guard). */
  let lastAppliedPair: { provider: string; model: string } | undefined
  const effortCache = new Map<string, readonly string[] | undefined>()

  const warn = (message: string): void => deps.logger?.warn(message)

  const tierRoute = (tier: number): ResolvedRoute | undefined => {
    const alias = tierAt(tier)
    const route = alias === undefined ? undefined : deps.routes?.()?.resolve(alias)
    if (route === undefined || route.provider === undefined || route.model === undefined) {
      if (!routesWarned) {
        routesWarned = true
        warn(`moa: tier route for "${alias ?? tier}" unresolved; failing open to the live selection`)
      }
      return undefined
    }
    return route
  }

  /** One side-car route record (§7 R1, mirrored as a JSONL side-car row). */
  const logRoute = async (row: {
    turnId: number
    originSeq?: number
    tier?: string
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
   * Status-row delivery (§3.1 — a classify is NEVER silent): rows are QUEUED
   * and appended to the NEXT `agent/pre-step` decision's messages
   * (mcpReadyNotice precedent). A mid-waterfall `agent.inject` wakes a
   * continuation turn right after the current one settles (observed live: an
   * extra `agent/request` firing), which would violate the pre-registered P3a
   * contract (firings == step count); a pre-step decision append lands the
   * row inside a step batch without waking the loop.
   */
  const pendingRows: { text: string; tier?: number }[] = []
  const queueNotice = (text: string, tier?: number): void => {
    pendingRows.push({ text, ...(tier === undefined ? {} : { tier }) })
  }

  /**
   * Apply the tier override AFTER `next()` (shallow copy, never in place —
   * cc-model-aliases service.ts:106-109 precedent), with effort
   * re-validation degrading exactly like `applyModelSwitch`
   * (driver-pickers.ts:98-119): unsupported carried effort → bare pair +
   * notice row.
   */
  const withTier = async (
    resolved: LlmCallConfig,
    tier: number,
    signal: AbortSignal,
  ): Promise<LlmCallConfig> => {
    const route = tierRoute(tier)
    if (route === undefined) return resolved
    const provider = route.provider as string
    const model = route.model as string
    lastAppliedPair = { provider, model }
    const carried = (resolved as { reasoningEffort?: unknown }).reasoningEffort
    if (typeof carried !== 'string' || carried.length === 0) {
      return { ...resolved, provider, model }
    }
    const key = `${provider}\u0000${model}`
    let efforts = effortCache.get(key)
    if (efforts === undefined && !effortCache.has(key)) {
      efforts = await deps.resolveEfforts?.(provider, model, signal).catch(() => undefined)
      effortCache.set(key, efforts)
    }
    if (efforts !== undefined && efforts.includes(carried)) {
      return { ...resolved, provider, model, reasoningEffort: ReasoningEffortId(carried) }
    }
    // Unsupported carried effort → degrade exactly like applyModelSwitch
    // (driver-pickers.ts:98-119): bare pair (drop the effort field) + notice.
    queueNotice(`Effort "${carried}" not supported by ${model}; reset to default.`)
    return { provider, model } as LlmCallConfig
  }

  const classifyOnce = async (
    payload: RequestPayload,
    opening: UserMessage,
  ): Promise<Decision | undefined> => {
    const settings = core.readSettings()
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
      signal: payload.signal,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    })
    const latencyMs = now() - startedAt
    if (!result.ok) {
      await logRoute({ turnId: payload.turn, latencyMs, truncated: false, failure: result.failure })
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
    await logRoute({
      turnId: payload.turn,
      ...(tier === undefined ? {} : { tier: TIER_ALIASES[tier] }),
      ...(probabilities === undefined ? {} : { probabilities }),
      latencyMs,
      truncated,
    })
    if (tier === undefined) return undefined
    return { tier, row: `moa: routed → ${TIER_ALIASES[tier]}` }
  }

  /** The whole-turn decision for a NEW turn (undefined = no override). */
  const decide = async (payload: RequestPayload): Promise<Decision | undefined> => {
    const opening = deps.getCapturedOpening(payload.turn)
    if (opening === undefined) return undefined // capture miss: fail-open
    if (isMoaEscalationMessage(opening.source)) {
      // §3.4 retry-turn routing contract: NEVER re-classify a retry — a
      // re-classify would route the retry back to the cheap tier and make
      // escalation a no-op. Apply the live origin-seq floor instead.
      // §6 adjudication: arming still gates overrides — an explicit /model
      // this session (disarmed machine) passes through unmodified even for
      // moa-escalation openings; classify is still skipped.
      const { originSeq } = opening.source as { originSeq: number }
      if (!arming.isArmed()) return undefined
      const floor = bookkeeping.floorFor(originSeq)
      if (floor === undefined) return undefined
      // §3.5 conformance change (S4): the router does NOT queue the
      // `moa: from → to` row — the typed followup the judge woke IS the
      // escalation status row; a queued duplicate would render two rows.
      return { tier: floor, row: '', suppressRow: true }
    }
    // Genuine-user gate: classify only genuine user turns.
    if (opening.source?.kind !== 'user') return undefined
    // §6 R6 pin: observe the LIVE pre-override pair FIRST. The session
    // request header is the user/boot selection — EXCEPT that the harness
    // re-stamps the header from the previous request's RESOLVED config, so
    // our own overlay pair shows up there next turn (self-feedback). When
    // the header pair is exactly what moa applied last, skip the observe:
    // it carries no user intent, and observing it would disarm the machine.
    const header = requestHeaderOf(payload.agent)
    if (
      lastAppliedPair === undefined ||
      header === undefined ||
      header.provider !== lastAppliedPair.provider ||
      header.model !== lastAppliedPair.model
    ) {
      arming.observeRequestModel({ provider: header?.provider, model: header?.model })
    }
    if (!opts.validation.ok) opts.ensureArmed?.()
    if (!arming.isArmed() || !opts.validation.ok) return undefined
    const decided = await classifyOnce(payload, opening)
    return decided
  }

  return {
    tierFor: (turnId: number) => (turnTier !== undefined && turnTier.turn === turnId ? turnTier.tier : undefined),
    listener: async (payload, next) => {
      // Fast bail: the §3.1 zero-overhead default-off contract.
      if (!core.readSettings().enabled) return next()
      const isNewTurn = payload.turn !== lastSeenTurn
      if (isNewTurn) {
        // Step-1 trigger pin: see the module doc — `payload.turn` change, NOT
        // step===0 (the first dispatched request of a turn carries step: 1).
        lastSeenTurn = payload.turn
        turnTier = undefined
        const decision = await decide(payload)
        if (decision !== undefined) turnTier = { turn: payload.turn, tier: decision.tier }
        const resolved = await next()
        const applied =
          decision === undefined ? resolved : await withTier(resolved, decision.tier, payload.signal)
        // Status row queued (delivered at the next pre-step decision, see
        // pendingRows): mid-waterfall inject is NOT used — it wakes a
        // continuation turn and breaks the P3a firings==steps contract.
        if (decision !== undefined && !decision.suppressRow) queueNotice(decision.row, decision.tier)
        return applied
      }
      if (turnTier !== undefined && turnTier.turn === payload.turn) {
        // P1: every step of a classified turn carries the override.
        const resolved = await next()
        return withTier(resolved, turnTier.tier, payload.signal)
      }
      return next()
    },
    // Pre-step delivery for queued status rows: appended to the decision's
    // messages (mcpReadyNotice.ts:161 precedent — form 'notice' + summary),
    // one row per queued notice, then pass through.
    preStepListener: async (_payload, next) => {
      const decision = await next()
      if (pendingRows.length === 0) return decision
      const shape = decision as { kind?: string; messages?: UserMessage[] }
      if (shape.kind === 'reject' || shape.messages === undefined) return decision
      const rows = pendingRows.splice(0)
      return {
        ...shape,
        messages: [
          ...shape.messages,
          ...rows.map((row) =>
            createUserMessage({ content: [{ type: 'text', text: row.text }], source: moaNoticeSource(row.text, row.tier) }),
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

/** The live pre-override provider/model pair off the session request header. */
export function requestHeaderOf(
  agent: RequestPayload['agent'],
): { provider?: string; model?: string } | undefined {
  try {
    const config = agent.session.requestHeader()?.config as
      | { provider?: string; model?: string }
      | undefined
    if (config === undefined) return undefined
    return {
      ...(config.provider === undefined ? {} : { provider: config.provider }),
      ...(config.model === undefined ? {} : { model: config.model }),
    }
  } catch {
    return undefined
  }
}
