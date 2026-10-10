/**
 * Acceptance judge + escalation orchestration (design §3.3/§3.4/§3.5).
 *
 * Mounted as a capture-only `agent/turn-stopping` listener: the judge NEVER
 * blocks the turn-stopping waterfall. Inputs are captured synchronously
 * (opening text, origin seq, final answer, effect-free fact, stale-guard
 * snapshot), the judge call is dispatched DETACHED, and the listener returns
 * immediately — the verdict acts later, when the loop has already settled
 * idle (hence `agent.followup`, never `agent.inject`: grok r3).
 *
 * Gate: reject iff `P(acceptable) < tau` (never on System One `confidence`).
 * Any call failure fails open (accept, no action). One in-flight escalation
 * per agent (atomic reservation at dispatch, released on completion).
 *
 * @module
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { ModelRoutes, ResolvedRoute } from '@dsh-cc/model-aliases'
import { appendJsonl } from '@dsh-cc/sidecar-io'
import { capMiddleToTokenBudget, systemoneDecide } from '@dsh-cc/systemone'
import { resolveJudgeRoute } from './judge-route.ts'
import { MOA_ESCALATION_KIND } from './state.ts'
import { TIER_ALIASES, tierAt } from './tiers.ts'
import type { MoaCore } from './index.ts'
import type { ArmingValidation } from './router.ts'

/** Same crop marker contract as the router (§3.3). */
const CROP_MARKER = '[…truncated…]'

/** moa-local binary acceptance question (ported from the P5 probe corpus). */
export const ACCEPT_QUESTION = {
  type: 'choice',
  instructions: 'Judge whether the assistant answer correctly and adequately addresses the user request.',
  criteria: {
    acceptable: 'the answer is factually correct, addresses the actual request, and would let the user proceed without follow-up',
    unacceptable: 'the answer contains factual errors, buggy code, misses the point of the request, or fails to address it',
  },
} as const

/** Injected seams; every one is optional and degrades fail-open. */
export interface JudgeDeps {
  /** Pre-step capture read (§3.2). */
  getCapturedOpening(turnId: number): UserMessage | undefined
  /** The router's decided tier per turn (the tier the turn ran on). */
  tierFor(turnId: number): number | undefined
  /** The `ccModelRoutes` accessor for judge-route resolution. */
  routes?: (() => ModelRoutes | undefined) | undefined
  /** System One gateway facts for the judge route. */
  resolveBackend?: ((route: ResolvedRoute) => { baseURL: string; apiKey?: string } | undefined) | undefined
  /** Injectable fetch for `systemoneDecide` (tests). */
  fetchImpl?: (typeof fetch) | undefined
  /** Escalate rows land here (`<dshHome>/moa/routing.jsonl`). */
  routingLedgerPath?: (() => string | undefined) | undefined
  /** Judge verdict rows land here (`<dshHome>/moa/acceptance.jsonl`). */
  acceptanceLedgerPath?: (() => string | undefined) | undefined
  logger?: { warn(message: string): void } | undefined
  now?: (() => number) | undefined
}

/** Stale-guard snapshot taken synchronously at turn end (§3.4/§6). */
interface JudgeSnapshot {
  turn: number
  originSeq: number
  fromTier: number
  /** Any later genuine user/message or request/header['change'] event ⇒ stale. */
  watermark: number
  /** Identity refs for the fork guard. */
  agent: Agent
  sessionId: string
  /** The turn's final answer text (empty ⇒ judge inapplicable). */
  answer: string
  /** The originating genuine user request text. */
  request: string
  /** Compact digest of the turn's tool receipts (shadow calibration input). */
  receipts: string
}

export interface AcceptanceJudge {
  /** The `agent/turn-stopping` listener: capture + detached dispatch. */
  listener(payload: { agent: Agent; turn: number; signal: AbortSignal }): void
  /** Test seam: whether an escalation is currently in flight for the agent. */
  isInFlight(agent: Agent): boolean
}

/** Structurally readable view of the session events this module folds. */
interface LogEvent {
  seq: number
  type: string
  data: {
    turn?: number
    source?: { kind?: string }
    reason?: string
    content?: { type: string; text?: string }[]
    message?: { content?: { type: string; text?: string }[] }
    name?: string
    arguments?: string
  }
}

export function createAcceptanceJudge(
  core: MoaCore,
  opts: { validation: ArmingValidation; deps: JudgeDeps },
): AcceptanceJudge {
  const { arming, bookkeeping } = core
  const deps = opts.deps
  const warn = (message: string): void => deps.logger?.warn(message)
  const now = deps.now ?? Date.now
  /** One in-flight escalation per agent (§3.4): keyed by agent reference. */
  const inFlight = new WeakSet<object>()

  const logJudge = async (row: Record<string, unknown>): Promise<void> => {
    const path = deps.acceptanceLedgerPath?.()
    if (path === undefined) return
    await appendJsonl(path, { type: 'judge', ts: new Date().toISOString(), ...row })
  }
  const logEscalate = async (row: { originSeq: number; fromTier: number; toTier: number }): Promise<void> => {
    const path = deps.routingLedgerPath?.()
    if (path === undefined) return
    await appendJsonl(path, { type: 'escalate', ts: new Date().toISOString(), ...row })
  }

  /** Plain-text projection of message content blocks. */
  const textBlocks = (content: { type: string; text?: string }[] | undefined): string =>
    (content ?? [])
      .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter((text) => text.length > 0)
      .join('\n')

  /**
   * Eligibility to ACT (§3.4 gate) — also the shadow record's `eligible`
   * flag (§3.3: would-this-turn-have-been-escalatable). Conditions: armed +
   * routed turn + effect-free + retries left + below the masterplan ceiling.
   */
  const isEscalatable = (snap: JudgeSnapshot, effectFree: boolean): boolean =>
    arming.isArmed() &&
    opts.validation.ok &&
    snap.fromTier >= 0 && // the turn ran under moa routing
    effectFree &&
    snap.fromTier < TIER_ALIASES.length - 1 && // hard ceiling: masterplan
    (bookkeeping.stateFor(snap.originSeq)?.retriesUsed ?? 0) < Math.min(core.readSettings().maxEscalations, 3)

  /** Capture the judge inputs synchronously at turn-stopping. */
  const capture = (payload: { agent: Agent; turn: number }): { snap: JudgeSnapshot; effectFree: boolean } | undefined => {
    const opening = deps.getCapturedOpening(payload.turn)
    if (opening === undefined) return undefined
    const agent = payload.agent
    const session = agent.session as unknown as { snapshotEvents(): readonly unknown[]; seq: number; id: unknown }
    if (session?.snapshotEvents === undefined) return undefined
    const events = session.snapshotEvents() as unknown as LogEvent[]
    // Origin seq: the turn's opening user/message HAS been appended by
    // turn-stopping (§3.2). It is the claimed batch's LAST element, but NOT
    // necessarily the log's last user/message — a multi-step turn can append
    // a trailing queued status row after it — so match the capture by text.
    const openingText = textBlocks(opening.content as never)
    if (openingText.length === 0) return undefined
    const lastUser = events.findLast(
      (event) => event.type === 'user/message' && textBlocks(event.data.content) === openingText,
    )
    if (lastUser === undefined) return undefined
    const request = textBlocks(lastUser.data.content)
    // Final answer: last assistant/message OF THIS TURN (abort/error turns
    // produce none — never take an older turn's tail message).
    const finalAnswer = events.findLast(
      (event) => event.type === 'assistant/message' && event.data.turn === payload.turn,
    )
    if (finalAnswer === undefined) return undefined
    const answer = textBlocks(finalAnswer.data.message?.content)
    if (answer.length === 0) return undefined
    // Effect-free fact (§3.4): ZERO tool calls in this turn (first and retry
    // turns alike), read from the turn's session events.
    const toolCalls = events.filter((event) => event.type === 'tool/call' && event.data.turn === payload.turn)
    const receipts = toolCalls
      .map((event) => `${event.data.name ?? '?'}(${(event.data.arguments ?? '').slice(0, 200)})`)
      .join('\n')
    return {
      effectFree: toolCalls.length === 0,
      snap: {
        turn: payload.turn,
        originSeq: Number(lastUser.seq),
        fromTier: deps.tierFor(payload.turn) ?? -1,
        watermark: Number(session.seq),
        agent,
        sessionId: String(session.id),
        answer,
        request,
        receipts,
      },
    }
  }

  /** The stale-result guard (§3.4/§6, critic r4). */
  const isStale = (snap: JudgeSnapshot): string | undefined => {
    let events: LogEvent[]
    try {
      if (String(snap.agent.session.id) !== snap.sessionId) return 'session identity changed (fork)'
      events = snap.agent.session.snapshotEvents() as unknown as LogEvent[]
    } catch {
      return 'agent gone'
    }
    for (const event of events) {
      if (Number(event.seq) < snap.watermark) continue
      // A NEW GENUINE user message invalidates the verdict; the escalation's
      // own typed followup (kind !== 'user') must never trip this (critic r4).
      if (event.type === 'user/message' && event.data.source?.kind === 'user') {
        return 'new genuine user message'
      }
      // A /model change invalidates even if it later switched back: the
      // log-only request/header 'change' event stays in the log (critic r2).
      if (event.type === 'request/header' && event.data.reason === 'change') {
        return 'model changed (/model)'
      }
    }
    return undefined
  }

  /** Detached verdict pipeline: call → guards → escalate. */
  const judgeAsync = async (snap: JudgeSnapshot, shadow: boolean, eligible: boolean): Promise<void> => {
    const settings = core.readSettings()
    const startedAt = now()
    let pAcceptable: number | undefined
    let failure: string | undefined
    try {
      const judgeRoute = resolveJudgeRoute(settings.judgeRoute, {
        modelRoutes: deps.routes?.(),
        budgetTokens: settings.classifyBudgetTokens,
      })
      const backend = judgeRoute.ok ? deps.resolveBackend?.(judgeRoute.route) : undefined
      if (!judgeRoute.ok || backend === undefined) {
        failure = judgeRoute.ok ? 'no backend' : judgeRoute.reason
      } else {
        const receiptsPart = snap.receipts.length === 0 ? '' : `\n\nTool receipts:\n${snap.receipts}`
        const state = capMiddleToTokenBudget(
          `User request:\n${snap.request}\n\nFinal answer:\n${snap.answer}${receiptsPart}`,
          settings.classifyBudgetTokens,
          CROP_MARKER,
        )
        const result = await systemoneDecide({
          baseURL: backend.baseURL,
          ...(backend.apiKey === undefined ? {} : { apiKey: backend.apiKey }),
          model: `${judgeRoute.route.provider}/${judgeRoute.route.model}`,
          state,
          questions: { accept: ACCEPT_QUESTION },
          timeoutMs: settings.callBudgetMs,
          ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
        })
        if (!result.ok) {
          failure = `${result.failure}: ${result.reason}`
        } else {
          const p = result.answers.accept?.probabilities?.acceptable
          // Gate ONLY on the per-label probability (never `confidence` —
          // entropy-normalized, not threshold-safe; §3.3).
          if (typeof p !== 'number') failure = 'missing acceptable probability'
          else pAcceptable = p
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    const latencyMs = now() - startedAt
    const base = {
      turn: snap.turn,
      originSeq: snap.originSeq,
      tier: TIER_ALIASES[snap.fromTier],
      tau: settings.acceptance.tau,
      shadow,
      eligible,
      latencyMs,
    }
    // Fail-open: ANY call failure accepts (no action) — §3.3.
    if (pAcceptable === undefined) {
      await logJudge({ ...base, pAcceptable: undefined, acted: false, reason: `failure: ${failure ?? 'unknown'}` }).catch(
        () => undefined,
      )
      return
    }
    const rejected = pAcceptable < settings.acceptance.tau
    if (!rejected || shadow) {
      await logJudge({
        ...base,
        pAcceptable,
        acted: false,
        reason: rejected ? 'shadow: would escalate' : 'acceptable',
      }).catch(() => undefined)
      return
    }
    // Stale-result guard before acting (§3.4/§6).
    const staleReason = isStale(snap)
    if (staleReason !== undefined) {
      await logJudge({ ...base, pAcceptable, acted: false, reason: `stale: ${staleReason}` }).catch(() => undefined)
      return
    }
    const toTier = snap.fromTier + 1
    const row = `moa: ${tierAt(snap.fromTier) ?? snap.fromTier} → ${tierAt(toTier) ?? toTier}, first answer rejected by judge`
    try {
      bookkeeping.recordRetryUsed(snap.originSeq, snap.fromTier, toTier)
    } catch (error) {
      // Bookkeeping invariant violation = bug; fail-safe (no followup).
      warn(`moa: escalation bookkeeping rejected the retry (${error instanceof Error ? error.message : String(error)})`)
      return
    }
    // The typed followup IS the visible escalation status row (§3.5 single
    // row): durable user/message, moa-escalation provenance, form notice —
    // never a raw re-send of the user text with source.kind 'user' (that
    // would re-trigger classification and reset bookkeeping).
    snap.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: row }],
        source: {
          kind: MOA_ESCALATION_KIND,
          originSeq: snap.originSeq,
          fromTier: snap.fromTier,
          toTier,
          form: 'notice',
          summary: row,
        },
      }),
    )
    await logJudge({ ...base, pAcceptable, acted: true, reason: 'escalated' }).catch(() => undefined)
    await logEscalate({ originSeq: snap.originSeq, fromTier: snap.fromTier, toTier }).catch(() => undefined)
  }

  return {
    listener: (payload) => {
      try {
        const settings = core.readSettings()
        const act = settings.acceptance.enabled === true
        const shadow = !act && settings.acceptance.shadow === true
        if (!act && !shadow) return
        const captured = capture(payload)
        if (captured === undefined || captured.snap.fromTier < 0) return
        const eligible = isEscalatable(captured.snap, captured.effectFree)
        // Act mode runs the judge ONLY when escalation is still possible
        // (§3.3: a verdict with no user-visible outcome is wasted spend).
        // Shadow mode runs on ANY turn end (tool turns included).
        if (act && !eligible) return
        if (inFlight.has(payload.agent)) return
        inFlight.add(payload.agent)
        void judgeAsync(captured.snap, shadow, eligible).finally(() => inFlight.delete(payload.agent))
      } catch (error) {
        warn(`moa: judge capture failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    isInFlight: (agent) => inFlight.has(agent),
  }
}
