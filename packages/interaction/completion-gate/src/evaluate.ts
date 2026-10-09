/**
 * Evaluate+nudge pipeline (plan
 * docs/plans/2026-10-09-runtime-verified-completion.md §3.3–§3.4): pure-ish
 * decision pipeline over the session view — inputs are the turn-stopping
 * payload face ({agent, turn}), a settings snapshot, the lineage registry,
 * and the process-local nudge latch; the output is an action verdict plus a
 * reason. All IO (event append, inject) is guarded: failures debug-log and
 * never throw into the turn-stopping handler.
 *
 * Window rules (§3.3): the window starts at the LAST genuine `user/message`
 * preceding the JUDGED assistant message (session start when none), and runs
 * to the judged message — never to the turn boundary.
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
import { NUDGE_EVENT, RECEIPT_EVENT, RESOLVED_EVENT, type Receipt } from './events.ts'
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

/** Collaborators of the evaluate pipeline (tests duck-type these). */
export interface EvaluateDeps {
  /** Settings snapshot read synchronously by the caller. */
  settings: GateSettings
  lineage: LineageRegistry
  /** Process-local budget mirror: sessionId → nudges emitted this process. */
  latches: Map<string, number>
  debug(message: string): void
}

/** The evaluate outcome: act (with the unmatched claim ids) or skip with a reason. */
export type EvalOutcome =
  | { action: 'nudge'; claims: string[] }
  | { action: 'skip'; reason: string }

const skip = (reason: string): EvalOutcome => ({ action: 'skip', reason })

/** Compiled claim table, loaded once (rows without `head` dropped at load). */
let claimsTable: CompiledClaim[] | undefined
function claims(): CompiledClaim[] {
  claimsTable ??= loadClaims()
  return claimsTable
}

/** Top-level-only predicate (advisor wiring.ts:46-50 precedent). */
export function isTopLevel(agent: EvalAgent): boolean {
  const header = agent.session.header
  return header?.origin !== 'subagent' && ((header?.delegationDepth as number | undefined) ?? 0) <= 0
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

/**
 * Run the full evaluate pipeline for one `agent/turn-stopping` payload.
 * Never throws; every guarded failure is debug-logged.
 */
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
  const sessionId = typeof agent.session.header?.id === 'string' ? agent.session.header.id : undefined
  // No session ⇒ nudges skip (§3.6).
  if (sessionId === undefined) return skip('no-session')

  const events = agent.session.snapshotEvents()
  // Judged message + turn guard (§3.3).
  const judgedIdx = findJudgedMessage(events, turn)
  if (judgedIdx < 0) return skip('turn-guard')
  const judgedText = textOf(events[judgedIdx]!.data?.message?.content)

  // Skip rule: our own nudge precedes the judged message (§3.3).
  if (suppressedByOwnNudge(events, judgedIdx)) return skip('suppressed')

  // Window anchor + 1-based genuine ordinal (0 for session-start windows).
  const startIdx = windowStartIndex(events, judgedIdx)
  const startOrdinal = startIdx < 0 ? 0 : countGenuineUserMessages(events.slice(0, startIdx + 1))
  const window = events.slice(startIdx + 1, judgedIdx)

  // Compaction fail-open (§3.6): compaction/end inside the window ⇒ skip.
  if (window.some(event => event.type === 'compaction/end')) return skip('compaction')

  // Composite fail-open (§3.6): tools ran but zero receipts anywhere in the
  // view ⇒ the evidence view is broken; zero receipts AND zero tool events is
  // exactly the fabricated-completion case — gate stays armed.
  const receiptCount = events.reduce((n, event) => n + (event.type === RECEIPT_EVENT ? 1 : 0), 0)
  const hasToolEvent = events.some(event => event.type === 'tool/call' || event.type === 'tool/result')
  if (receiptCount === 0 && hasToolEvent) return skip('composite-fail-open')

  const windowReceipts = window
    .filter(event => event.type === RECEIPT_EVENT)
    .map(event => event.data as { tool: string; head?: string })

  // Horizon rule (§3.4): delegation receipts but no witnessed child in-process.
  const root = walkRoot(sessionId, deps.lineage.parents)
  if (horizonDegraded(windowReceipts, deps.lineage.witnessedChildren(root))) {
    return skip('horizon')
  }

  // Satisfiability union (§3.3 step 3): own in-window receipts OR
  // lineage-lifted entries stamped at/after the window-start ordinal.
  const lifts = deps.lineage.liftsFor(root)
  const matched = matchPhrases(claims(), judgedText)
  const unmatched = matched.filter(claim =>
    !windowReceipts.some(receipt => receiptSatisfies(claim, receipt))
    && !lifts.some(lift => lift.stampedOrdinal >= startOrdinal && receiptSatisfies(claim, lift)),
  )
  if (unmatched.length === 0) {
    return skip(matched.length === 0 ? 'no-claim' : 'satisfied')
  }

  // Budget: in-session nudge events + process-local latch (§3.4 step 3).
  // The latch MIRRORS the durable count (it exists only so a failed event
  // append cannot re-arm the gate) — take the max, never the sum.
  const nudgeEvents = events.reduce((n, event) => n + (event.type === NUDGE_EVENT ? 1 : 0), 0)
  const spent = Math.max(nudgeEvents, deps.latches.get(sessionId) ?? 0)
  if (spent >= deps.settings['nudges-per-session']) return skip('budget')

  // Append per-claim nudge events (try/catch + debug; failure never blocks
  // the inject — the latch still prevents a loop).
  const assistantTextHash = digest16(judgedText)
  for (const claim of unmatched) {
    try {
      agent.session.append?.(NUDGE_EVENT, { claim: claim.id, missingReceipt: true, assistantTextHash })
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
