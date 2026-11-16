/**
 * Evaluate+nudge pipeline (plans docs/plans/2026-10-09-runtime-verified-
 * completion.md §3.3–§3.4 and docs/plans/2026-11-17-completion-gate-enforce-
 * mode.md §3.3–§3.5): pure-ish decision pipeline over the session view. IO
 * (event append, inject) is guarded — failures debug-log and never throw into
 * the turn-stopping handler.
 *
 * Window (§3.3): from the LAST genuine `user/message` preceding the JUDGED
 * assistant message (session start when none) to that message. The two modes
 * branch in `evaluateInner`; enforce exhaustion is observed at turn-stopping
 * and recorded terminally by the `turn/end` reconciliation.
 *
 * @module @dsh-cc/completion-gate/evaluate
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  loadClaims,
  matchPhrases,
  receiptSatisfies,
  type CompiledClaim,
} from './claims.ts'
import {
  EXHAUSTED_EVENT,
  NUDGE_EVENT,
  RECEIPT_EVENT,
  RESOLVED_EVENT,
  type EnforceMarker,
  type Receipt,
} from './events.ts'
import {
  countGenuineUserMessages,
  horizonDegraded,
  walkRoot,
  type LineageRegistry,
} from './lineage.ts'
import { digest16 } from './receipts.ts'
import type { GateSettings } from './settings.ts'

/** One session-view event (structural minimum; `seq` unused — order is array order). */
export interface EvalEvent {
  type: string
  data: any
  seq?: number
}

/** Structural minimum of the Session face used by the evaluate side. */
export interface EvalSession {
  header?: { id?: unknown; origin?: unknown; delegationDepth?: unknown }
  snapshotEvents(): readonly EvalEvent[]
  append?(type: string, data: unknown): void
}

/** Structural minimum of the turn-stopping payload's agent face. */
export interface EvalAgent {
  session: EvalSession
  inject?(message: unknown): void
}

/** One session's enforce cycle mirror entry (§3.3 step 1): per-window counters. */
export interface EnforceMirrorEntry {
  /** Genuine-user ordinal of the window the count belongs to. */
  windowOrdinal: number
  /** Cycles spent in that window. */
  spent: number
  /** Set when the window's LAST inject threw (§3.3 step 3). */
  lastInjectFailed?: boolean
}

/** Collaborators of the evaluate pipeline (tests duck-type these). */
export interface EvaluateDeps {
  /** Settings snapshot read synchronously by the caller. */
  settings: GateSettings
  lineage: LineageRegistry
  /** Process-local budget mirror: sessionId → nudges emitted this process. */
  latches: Map<string, number>
  /** Process-local enforce cycle mirror (§3.3 step 1). */
  enforceMirror: Map<string, EnforceMirrorEntry>
  /** `${sessionId}:${turn}` of turns whose enforce budget ran out (§3.3 step 2). */
  exhaustedTurns: Set<string>
  debug(message: string): void
}

/** The evaluate outcome: act (with the unmatched claim ids), stall, or skip with a reason. */
export type EvalOutcome =
  | { action: 'nudge'; claims: string[] }
  | { action: 'skip'; reason: string }
  | { action: 'stall'; claims: string[] }

const skip = (reason: string): EvalOutcome => ({ action: 'skip', reason })

/** Wording of the final inject of a window (§3.3, r2 — do not overstate the exit). */
const LAST_CHANCE_FOOTER =
  'Last chance: if the next judged message still contains the claim, the gate will not '
  + 'inject again; the turn records unverified when it actually ends.'

/** Compiled claim table, loaded once (rows without `head` dropped at load). */
let claimsTable: CompiledClaim[] | undefined
function claims(): CompiledClaim[] {
  claimsTable ??= loadClaims()
  return claimsTable
}

/** Top-level session predicate (advisor wiring.ts:46-50 precedent). */
export function isTopLevelSession(session: EvalSession): boolean {
  const header = session.header
  return header?.origin !== 'subagent' && ((header?.delegationDepth as number | undefined) ?? 0) <= 0
}

/** Top-level-only predicate for the agent face. */
export function isTopLevel(agent: EvalAgent): boolean {
  return isTopLevelSession(agent.session)
}

/** Joined text of a content block list (turn-rules idiom). */
function textOf(content: readonly { type?: string; text?: string }[] | undefined): string {
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n')
}

/** The genuine-user predicate of §3.3 (session-event analogue). */
function isGenuineUser(event: EvalEvent): boolean {
  if (event.type !== 'user/message') return false
  const source = event.data?.source
  return source === undefined || source === null || source.kind === 'user'
}

/**
 * Index of the final `assistant/message` with `data.turn === turn`, or -1.
 * Turn guard (§3.3): an aborted/errored turn that produced no assistant
 * message must not recycle an earlier turn's final message.
 */
export function findJudgedMessage(events: readonly EvalEvent[], turn: number): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type === 'assistant/message' && event.data?.turn === turn) return i
  }
  return -1
}

/**
 * Skip rule (§3.3): the latest `user/message` preceding the JUDGED message is
 * our own nudge ⇒ skip (anchored to the judged message, never turn/start).
 * NUDGE MODE ONLY — in enforce mode the preceding gate nudge IS the loop and
 * the cycle budget is the guard.
 */
export function suppressedByOwnNudge(events: readonly EvalEvent[], judgedIndex: number): boolean {
  for (let i = judgedIndex - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type === 'user/message') {
      return event.data?.source?.kind === 'completion-gate'
    }
  }
  return false
}

/**
 * Window anchor (§3.3): index of the last genuine `user/message` before
 * `beforeIndex`, or -1 (window from session start).
 */
export function windowStartIndex(events: readonly EvalEvent[], before: number): number {
  for (let i = before - 1; i >= 0; i--) {
    if (isGenuineUser(events[i]!)) return i
  }
  return -1
}

/** Receipt fields the satisfaction union reads (outcome only matters in enforce mode). */
interface WindowReceipt {
  tool: string
  head?: string
  outcome?: 'ok' | 'error'
}

/** One window anchor pair: the start index plus the 1-based genuine ordinal. */
export interface WindowAnchor {
  startIndex: number
  startOrdinal: number
}

/** The shared evidence computation: a skip reason, or everything the tails need. */
export type UnmatchedComputation =
  | { action: 'skip'; reason: string }
  | ({
      action: 'compute'
      sessionId: string
      judgedIndex: number
      judgedText: string
      assistantTextHash: string
      matched: CompiledClaim[]
      unmatched: CompiledClaim[]
    } & WindowAnchor)

/**
 * The ONE evidence computation shared by the live turn-stopping pipeline and
 * the `turn/end` reconciliation (§3.5 step 2 — no duplicated drift): judged
 * message (turn guard), window anchor, the fail-opens (compaction, composite,
 * horizon, no-session), and the claim-satisfiability union.
 *
 * `requireOk` applies the enforce-mode filter (§3.3): receipts and lifts whose
 * `outcome` is not `ok` cannot satisfy a claim. The horizon check always reads
 * the UNFILTERED receipts, so the fail-open decision is mode-independent.
 */
export function computeUnmatched(
  session: EvalSession,
  turn: number,
  deps: { lineage: LineageRegistry },
  requireOk: boolean,
): UnmatchedComputation {
  const sessionId = typeof session.header?.id === 'string' ? session.header.id : undefined
  if (sessionId === undefined) return { action: 'skip', reason: 'no-session' }

  const events = session.snapshotEvents()
  const judgedIdx = findJudgedMessage(events, turn)
  if (judgedIdx < 0) return { action: 'skip', reason: 'turn-guard' }
  const judgedText = textOf(events[judgedIdx]!.data?.message?.content)

  const startIdx = windowStartIndex(events, judgedIdx)
  const startOrdinal = startIdx < 0 ? 0 : countGenuineUserMessages(events.slice(0, startIdx + 1))
  const window = events.slice(startIdx + 1, judgedIdx)

  // Compaction fail-open (§3.6): compaction/end inside the window ⇒ skip.
  if (window.some(event => event.type === 'compaction/end')) return { action: 'skip', reason: 'compaction' }

  // Composite fail-open (§3.6): tools ran but zero receipts anywhere in the
  // view ⇒ the evidence view is broken; zero receipts AND zero tool events is
  // exactly the fabricated-completion case — gate stays armed in both modes.
  const receiptCount = events.reduce((n, event) => n + (event.type === RECEIPT_EVENT ? 1 : 0), 0)
  const hasToolEvent = events.some(event => event.type === 'tool/call' || event.type === 'tool/result')
  if (receiptCount === 0 && hasToolEvent) return { action: 'skip', reason: 'composite-fail-open' }

  const windowReceipts: WindowReceipt[] = window
    .filter(event => event.type === RECEIPT_EVENT)
    .map(event => event.data as WindowReceipt)

  // Horizon rule (§3.4): delegation receipts but no witnessed child in-process.
  // Deliberately UNFILTERED (r2: the horizon decision must not change).
  const root = walkRoot(sessionId, deps.lineage.parents)
  if (horizonDegraded(windowReceipts, deps.lineage.witnessedChildren(root))) {
    return { action: 'skip', reason: 'horizon' }
  }

  // Satisfiability union (§3.3): own in-window receipts OR lineage-lifted
  // entries stamped at/after the window-start ordinal, `ok`-only in enforce.
  const usableReceipts = requireOk
    ? windowReceipts.filter(receipt => receipt.outcome === 'ok')
    : windowReceipts
  const lifts = deps.lineage.liftsFor(root)
  const usableLifts = requireOk ? lifts.filter(lift => lift.outcome === 'ok') : lifts
  const matched = matchPhrases(claims(), judgedText)
  const unmatched = matched.filter(claim =>
    !usableReceipts.some(receipt => receiptSatisfies(claim, receipt))
    && !usableLifts.some(lift => lift.stampedOrdinal >= startOrdinal && receiptSatisfies(claim, lift)),
  )

  return {
    action: 'compute',
    sessionId,
    judgedIndex: judgedIdx,
    judgedText,
    assistantTextHash: digest16(judgedText),
    startIndex: startIdx,
    startOrdinal,
    matched,
    unmatched,
  }
}

/**
 * Window-scoped enforce cycle count (§3.3 step 1): `max(durableCycles, mirror)`
 * — the max numeric `cycle` over NUDGE events after the window start (nudge-mode
 * events carry no `cycle`) plus the mirror for the SAME genuine-user ordinal.
 * Shared with the reconciliation, which recomputes it from the durable events.
 */
export function spentCycles(
  events: readonly EvalEvent[],
  sessionId: string,
  window: WindowAnchor,
  mirror: ReadonlyMap<string, EnforceMirrorEntry>,
): number {
  let durable = 0
  for (let i = Math.max(window.startIndex + 1, 0); i < events.length; i++) {
    const event = events[i]!
    if (event.type !== NUDGE_EVENT) continue
    const cycle = event.data?.cycle
    if (typeof cycle === 'number' && Number.isFinite(cycle) && cycle > durable) durable = cycle
  }
  const entry = mirror.get(sessionId)
  const mirrored = entry !== undefined && entry.windowOrdinal === window.startOrdinal ? entry.spent : 0
  return Math.max(durable, mirrored)
}

/** Run the full evaluate pipeline for one turn-stopping payload; never throws. */
export function evaluateTurnStopping(agent: EvalAgent, turn: number, deps: EvaluateDeps): EvalOutcome {
  try {
    return evaluateInner(agent, turn, deps)
  } catch (error: unknown) {
    deps.debug(`completion-gate: evaluate failed: ${String(error)}`)
    return skip('error')
  }
}

function evaluateInner(agent: EvalAgent, turn: number, deps: EvaluateDeps): EvalOutcome {
  // Top-level only (§3.4); receipts are unaffected (recorded in E1 wiring).
  if (!isTopLevel(agent)) return skip('not-top-level')
  // Enabled gate (§3.5): live sync re-read happened in the caller.
  if (!deps.settings.enabled) return skip('disabled')

  const enforce = deps.settings.mode === 'enforce'
  // Skip rule (§3.3): NUDGE MODE ONLY — in enforce mode the preceding gate
  // nudge is the loop, bounded by the cycle budget.
  if (!enforce) {
    const events = agent.session.snapshotEvents()
    if (suppressedByOwnNudge(events, findJudgedMessage(events, turn))) return skip('suppressed')
  }

  const computed = computeUnmatched(agent.session, turn, deps, enforce)
  if (computed.action === 'skip') return computed
  if (computed.unmatched.length === 0) {
    return skip(computed.matched.length === 0 ? 'no-claim' : 'satisfied')
  }
  return enforce
    ? runEnforceMode(agent, turn, deps, computed)
    : runNudgeMode(agent, deps, computed)
}

/** Today's advisory tail (§3.3 nudge mode), with an advisory-only budget count. */
function runNudgeMode(
  agent: EvalAgent,
  deps: EvaluateDeps,
  computed: Extract<UnmatchedComputation, { action: 'compute' }>,
): EvalOutcome {
  const session = agent.session
  const { sessionId, assistantTextHash, judgedText, unmatched } = computed
  const events = session.snapshotEvents()

  // Budget: in-session ADVISORY nudge events (enforce cycles carry `cycle` and
  // must never consume this budget, §3.3) + process-local latch (§3.4 step 3).
  // The latch MIRRORS the durable count (it exists only so a failed event
  // append cannot re-arm the gate) — take the max, never the sum.
  const nudgeEvents = events.reduce(
    (n, event) => n + (event.type === NUDGE_EVENT && event.data?.cycle === undefined ? 1 : 0),
    0,
  )
  const spent = Math.max(nudgeEvents, deps.latches.get(sessionId) ?? 0)
  if (spent >= deps.settings['nudges-per-session']) return skip('budget')

  // Append per-claim nudge events (try/catch + debug; failure never blocks
  // the inject — the latch still prevents a loop).
  for (const claim of unmatched) {
    try {
      session.append?.(NUDGE_EVENT, { claim: claim.id, missingReceipt: true, assistantTextHash })
    } catch (error: unknown) {
      deps.debug(`completion-gate: nudge append failed: ${String(error)}`)
    }
  }
  deps.latches.set(sessionId, Math.max(deps.latches.get(sessionId) ?? 0, nudgeEvents) + unmatched.length)

  // Synchronous inject (§3.4 step 2): inside the handler, before returning.
  const text = unmatched
    .map(claim => {
      const phrase = judgedText.match(claim.phrase)?.[0] ?? claim.id
      return `Evidence check: you stated "${phrase}" but no executed record of ${claim.tool} exists since the last user message. Run it now or retract the claim. (completion-gate)`
    })
    .join('\n')
  try {
    agent.inject?.(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'completion-gate' },
    }))
  } catch (error: unknown) {
    deps.debug(`completion-gate: inject failed: ${String(error)}`)
  }
  return { action: 'nudge', claims: unmatched.map(claim => claim.id) }
}

/**
 * The enforce-mode cycle state machine (§3.3 step 2/3): spend one cycle
 * (cycle-bearing NUDGE events + ONE joined inject) or, once the window-scoped
 * budget is gone, record the exhaustion and stall. Never writes `deps.latches`.
 */
function runEnforceMode(
  agent: EvalAgent,
  turn: number,
  deps: EvaluateDeps,
  computed: Extract<UnmatchedComputation, { action: 'compute' }>,
): EvalOutcome {
  const session = agent.session
  const { sessionId, assistantTextHash, judgedText, unmatched, startIndex, startOrdinal } = computed
  const events = session.snapshotEvents()
  const max = deps.settings['enforce-max-cycles']
  const claims = unmatched.map(claim => claim.id)

  const spent = spentCycles(events, sessionId, { startIndex, startOrdinal }, deps.enforceMirror)
  if (spent >= max) {
    return recordExhaustion(session, sessionId, turn, deps, events, claims, assistantTextHash, startOrdinal)
  }

  const cycle = spent + 1
  // Mirror FIRST (§3.3 step 3): a failing append/inject below cannot re-arm
  // the loop with the same cycle.
  deps.enforceMirror.set(sessionId, { windowOrdinal: startOrdinal, spent: cycle })
  for (const claim of unmatched) {
    try {
      session.append?.(NUDGE_EVENT, { claim: claim.id, missingReceipt: true, assistantTextHash, cycle })
    } catch (error: unknown) {
      deps.debug(`completion-gate: enforce nudge append failed: ${String(error)}`)
    }
  }

  const remaining = max - cycle
  const footer = remaining > 0 ? `Gate cycles remaining: ${remaining}.` : LAST_CHANCE_FOOTER
  const text = unmatched
    .map(claim => {
      const phrase = judgedText.match(claim.phrase)?.[0] ?? claim.id
      return `Completion gate (enforced): you stated "${phrase}" but no successful executed record of ${claim.tool} exists since the last user message. Run it now, or make your next final message NOT contain the phrase "${phrase}" (that is the retraction). ${footer} (completion-gate)`
    })
    .join('\n')
  try {
    agent.inject?.(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'completion-gate' },
    }))
  } catch (error: unknown) {
    // Inject failure CONSUMES the cycle (§3.3 step 3): the mirror already
    // advanced; the flag tells the marker the model never saw the footer.
    deps.debug(`completion-gate: enforce inject failed: ${String(error)}`)
    deps.enforceMirror.set(sessionId, { windowOrdinal: startOrdinal, spent: cycle, lastInjectFailed: true })
  }
  return { action: 'nudge', claims }
}

/**
 * Record the exhaustion OBSERVATION (§3.3 step 2): the process-local set is
 * written UNCONDITIONALLY before the append (the reconciliation's append-failure
 * backstop), the append is idempotent per turn and fail-soft, nothing injects.
 */
function recordExhaustion(
  session: EvalSession,
  sessionId: string,
  turn: number,
  deps: EvaluateDeps,
  events: readonly EvalEvent[],
  claims: string[],
  assistantTextHash: string,
  startOrdinal: number,
): EvalOutcome {
  deps.exhaustedTurns.add(`${sessionId}:${turn}`)
  const payload: EnforceMarker = { turn, claims, assistantTextHash }
  const mirrorEntry = deps.enforceMirror.get(sessionId)
  if (mirrorEntry !== undefined && mirrorEntry.windowOrdinal === startOrdinal && mirrorEntry.lastInjectFailed === true) {
    payload.lastInjectFailed = true
  }
  const already = events.some(event => event.type === EXHAUSTED_EVENT && event.data?.turn === turn)
  if (!already) {
    try {
      session.append?.(EXHAUSTED_EVENT, payload)
    } catch (error: unknown) {
      deps.debug(`completion-gate: exhausted append failed: ${String(error)}`)
    }
  }
  return { action: 'stall', claims }
}

/**
 * Resolved side (§3.4 step 4), called from the post-execute path after a
 * receipt's session event lands: close the loop for any earlier nudge whose
 * claim THIS receipt satisfies and that has no resolved event yet. One
 * `resolved` is appended per satisfied open nudge; a retraction without a
 * receipt resolves nothing.
 */
export function maybeResolveOnReceipt(session: EvalSession, receipt: Receipt, debug: (message: string) => void): void {
  try {
    if (typeof session.append !== 'function') return
    const events = session.snapshotEvents()
    const openNudges: string[] = []
    const resolved = new Set<string>()
    for (const event of events) {
      if (event.type === NUDGE_EVENT) {
        const claim: string = event.data?.claim
        if (typeof claim === 'string') openNudges.push(claim)
      } else if (event.type === RESOLVED_EVENT) {
        const claim: string = event.data?.claim
        if (typeof claim === 'string') resolved.add(claim)
      }
    }
    for (const claim of openNudges) {
      if (resolved.has(claim)) continue
      const row = claims().find(entry => entry.id === claim)
      if (row !== undefined && receiptSatisfies(row, receipt)) {
        session.append(RESOLVED_EVENT, { claim, via: receipt.tool })
        resolved.add(claim)
      }
    }
  } catch (error: unknown) {
    debug(`completion-gate: resolved check failed: ${String(error)}`)
  }
}
