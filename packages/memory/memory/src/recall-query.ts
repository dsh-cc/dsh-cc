/**
 * The genuine-user query face of dynamic recall (design
 * docs/plans/2026-11-02-systemone-03-memory-recall.md §"Complete batching and
 * deterministic filtering", §"Query generations and when shown takes effect").
 *
 * Recall builds its query ONLY from real user input, and the active coordinator
 * additionally needs the PERSISTED `user/message` event that carried it: its
 * `seq` is the decision scope's origin and half of the local ticket key. Both
 * facts live here so the legacy branch and the coordinator share one definition
 * without importing each other. `session.seq` is NEVER the origin — it moves with
 * every appended event.
 *
 * @module @dsh-cc/memory/recall-query
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

/** One claimed pre-step message (structural subset of the harness face). */
export interface RecallMessageLike {
  content: readonly { type: string; text?: string }[]
  source?: { kind?: string }
}

/**
 * Injected source kinds whose pending pre-step messages must NEVER feed the
 * recall query — a query built from injected text yields empty selections
 * (no topic marked shown) and re-triggers recall on every woken turn, the
 * self-feeding phantom loop. KNOW YOUR INJECTOR: any new injected message
 * source kind must be added here.
 */
export const INJECTED_SOURCE_DENYLIST: readonly string[] = ['memory', 'cc-subagent-children', 'cc-workflow-completion', 'advisor', 'completion-gate', 'progress-rebuild']

/** One turn's recall subject: the query text and its persisted origin seq. */
export interface RecallTurn {
  /** The query text built from the batch's genuine user input. */
  query: string
  /** Session-log seq of this turn's real user message (never `session.seq`). */
  originSeq: number
}

/** Text of one message: its text blocks joined by a space. */
function messageText(message: RecallMessageLike): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join(' ')
}

/** Text blocks of a persisted message content array (non-empty blocks, newline-joined). */
function textBlocks(content: unknown): string {
  const blocks = Array.isArray(content) ? content : []
  return blocks
    .map((block) => {
      const candidate = block as { type?: unknown; text?: unknown }
      return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : ''
    })
    .filter(text => text.length > 0)
    .join('\n')
}

/** Structural subset of one session-log event used by the origin lookup. */
interface SnapshotEventLike {
  type?: unknown
  seq?: unknown
  data?: { content?: unknown; source?: { kind?: unknown } }
}

/**
 * The genuine-user predicate of this feature (design §"Complete batching": a
 * real user event has a missing `data.source` or `kind === 'user'`). New plugin
 * sources are NOT defaulted to user.
 * @param source - the event's `data.source`, when present.
 * @returns whether the event carries real user input.
 */
function isGenuineSource(source: { kind?: unknown } | undefined | null): boolean {
  return source === undefined || source === null || source.kind === 'user'
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
 * Resolve the turn's recall subject: its query text and the seq of the newest
 * persisted genuine `user/message` that carried that text.
 *
 * A batch of injected-only messages has no query; a query whose user event has
 * not been appended yet has no origin. Both yield `undefined` — the caller then
 * sends no request this round and writes no completed entry, waiting for a later
 * pre-step.
 * @param agent - the agent whose session log is consulted.
 * @param messages - the claimed pre-step message batch.
 * @returns the turn subject, or `undefined` when no persisted origin exists.
 */
export function resolveRecallTurn(
  agent: Agent,
  messages: readonly RecallMessageLike[],
): RecallTurn | undefined {
  const texts = messages
    .filter(message => message.source === undefined
      || !INJECTED_SOURCE_DENYLIST.includes(message.source.kind ?? ''))
    .map(messageText)
    .filter(text => text.length > 0)
  const query = texts.join('\n').trim()
  if (query.length === 0) return undefined
  // Match by text, newest event first. The joined batch text covers the common
  // single-message turn; a multi-message batch has no single persisted row, so
  // its LAST message text is the attribute origin (the batch's newest input).
  const last = texts[texts.length - 1]!
  const candidates = new Set<string>([query, last, last.trim()])
  const events = snapshotOf(agent)
  if (events === undefined) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message' || !isGenuineSource(event.data?.source)) continue
    if (!candidates.has(textBlocks(event.data?.content))) continue
    const seq = Number(event.seq)
    if (!Number.isSafeInteger(seq) || seq < 0) return undefined
    return { query, originSeq: seq }
  }
  return undefined
}
