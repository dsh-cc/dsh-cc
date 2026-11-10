/**
 * The genuine-user query face of dynamic recall (design
 * docs/plans/2026-11-02-systemone-03-memory-recall.md §"Complete batching and
 * deterministic filtering", §"Query generations and when shown takes effect";
 * origin redesign docs/plans/2026-11-10-systemone-shadow-activation-fixes.md
 * §2 — issue #359).
 *
 * Recall builds its query ONLY from genuine user input, identified by a
 * STRUCTURAL allowlist: the harness submits real user input with
 * `source.kind === 'user'` and every injector declares its own kind
 * (`packages/api/session-controller/src/commands.ts`,
 * `createUserMessage({ content, source })`), so a kind-allowlist cannot lag
 * behind new injectors the way the retired denylist filter did.
 *
 * The decision scope's origin is the seq of the turn's own `turn/start`
 * event: the harness appends a turn's `user/message` events only in the
 * request phase — AFTER the `agent/pre-step` waterfall returns — so a
 * user-message origin can never be resolved at pre-step time (the defect this
 * module now documents). `turn/start` is appended when the turn opens, before
 * the first claim, is unique per turn and stable for its whole lifetime.
 * `session.seq` is NEVER the origin — it moves with every appended event.
 *
 * @module @dsh-cc/memory/recall-query
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

/** One claimed pre-step message (structural subset of the harness face). */
export interface RecallMessageLike {
  content: readonly { type: string; text?: string }[]
  source?: { kind?: string } | null
}

/**
 * Injected source kinds observed in real claimed batches (inventory, NOT the
 * genuine test — {@link isGenuineUserMessage} is). Kept exported because
 * cross-package specs pin its membership (`progress-rebuild`
 * denylists.spec.ts, `completion-gate` denylist.spec.ts) and because the
 * sibling denylists (turn-rules `matcher.ts`, advisor-watchdog `delta.ts`)
 * remain operative filters of their own. New injectors do NOT need to be
 * listed here for memory recall to exclude them.
 */
export const INJECTED_SOURCE_DENYLIST: readonly string[] = [
  'memory',
  'cc-subagent-children',
  'cc-workflow-completion',
  'advisor',
  'completion-gate',
  'progress-rebuild',
  // Real-session claimed batches (issue #359, live transcript 2026-11-10):
  'cc-shell-glue',
  'hooks-claude-code',
  'moa',
  'agent-instructions',
  'runtime-context',
  'skill-catalog',
]

/** One turn's recall subject: the query text and its decision-scope origin. */
export interface RecallTurn {
  /** The query text built from the batch's genuine user input. */
  query: string
  /** Session-log seq of this turn's `turn/start` event (never `session.seq`). */
  originSeq: number
}

/**
 * The genuine-user predicate for CLAIMED messages: `source` absent (or null)
 * or `kind === 'user'`. A present source without a kind is NOT genuine — the
 * strict cell that keeps injected shapes out of the query.
 * @param message - one claimed pre-step message.
 * @returns whether the message carries real user input.
 */
export function isGenuineUserMessage(message: RecallMessageLike): boolean {
  return message.source === undefined || message.source === null
    || message.source.kind === 'user'
}

/** Text of one message: non-empty text blocks joined by newline (non-text blocks skipped). */
function messageText(message: RecallMessageLike): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .filter(text => text.length > 0)
    .join('\n')
}

/**
 * The genuine user query of one claimed batch: genuine texts joined by
 * newline, trimmed. Shared by the legacy selector branch and every decision
 * arm so both see exactly the same subject.
 * @param messages - the claimed pre-step batch.
 * @returns the query, or an empty string when the batch carries no genuine input.
 */
export function genuineUserQuery(messages: readonly RecallMessageLike[]): string {
  return messages
    .filter(isGenuineUserMessage)
    .map(messageText)
    .filter(text => text.length > 0)
    .join('\n')
    .trim()
}

/** Structural subset of one session-log event used by the origin lookup. */
interface SnapshotEventLike {
  type?: unknown
  seq?: unknown
}

/** The session-log snapshot of one agent, or `undefined` when the host has none. */
function snapshotOf(agent: Agent): readonly SnapshotEventLike[] | undefined {
  try {
    const session = agent.session as unknown as { snapshotEvents?: () => readonly unknown[] }
    if (typeof session?.snapshotEvents !== 'function') return undefined
    const events = session.snapshotEvents()
    return Array.isArray(events) ? (events as readonly SnapshotEventLike[]) : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the turn's recall subject: its query text and the seq of the
 * turn's own `turn/start` event.
 *
 * A batch of injected-only messages has no query; a snapshot with no
 * `turn/start` has no origin. Both yield `undefined` — the caller then sends
 * no request this round. There is no retry on a later pre-step: later steps
 * of the same turn claim nothing new, so the subject would never re-arrive.
 * @param agent - the agent whose session log is consulted.
 * @param messages - the claimed pre-step message batch.
 * @returns the turn subject, or `undefined` when there is no genuine query or no turn anchor.
 */
export function resolveRecallTurn(
  agent: Agent,
  messages: readonly RecallMessageLike[],
): RecallTurn | undefined {
  const query = genuineUserQuery(messages)
  if (query.length === 0) return undefined
  const events = snapshotOf(agent)
  if (events === undefined) return undefined
  // The newest turn/start is the current turn's own anchor: one per turn,
  // appended before the first claim, never moved afterwards.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'turn/start') continue
    const seq = Number(event.seq)
    if (!Number.isSafeInteger(seq) || seq < 0) return undefined
    return { query, originSeq: seq }
  }
  return undefined
}
