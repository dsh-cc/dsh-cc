/**
 * Pure delta extraction (plan docs/plans/2026-09-23-advisor-watchdog.md
 * §4.1): snapshot-window decision over the passive `llm/stream` snapshot,
 * injected-kind filtering, cursor state, and the newest-tailed ≤ 32 KiB
 * render. No I/O, no state.
 *
 * @module
 */

/** The advisory-notes render cap (§4.1). */
export const MAX_DELTA_BYTES = 32_768

/** Tool-call JSON args render cap (§4.1 render rule). */
export const MAX_TOOL_ARGS_BYTES = 2_000

/**
 * Injected source kinds whose messages NEVER enter a review delta (§4.1
 * step 3). Mirrors the recall.ts / turn-rules matcher denylists rather than
 * importing them (no shared export exists across those packages).
 * KNOW YOUR INJECTOR: any new injected message source kind must be added to
 * ALL THREE copies (recall.ts, turn-rules/matcher.ts, here) or a
 * self-feeding phantom loop re-opens.
 */
export const INJECTED_SOURCE_DENYLIST: readonly string[] = [
  'memory',
  'cc-subagent-children',
  'cc-workflow-completion',
  'turn-rules',
  'plugin',
  'advisor',
]

/** This plugin's own injected source kind (MessageSourceMap augmentation in wiring.ts). */
export const ADVISOR_SOURCE_KIND = 'advisor'

/** Cursor over the reviewed prefix of the snapshot messages. */
export interface Cursor {
  /** Number of snapshot messages already reviewed (or deliberately skipped). */
  count: number
  /** `JSON.stringify` of the message at `count - 1` (compaction anchor). */
  tail: string
}

/** Structural content-block subset of a `llm/stream` request message. */
export interface DeltaBlock {
  type: string
  text?: string
  /** `tool-call` blocks: the invoked tool name. */
  name?: string
  /** `tool-call` blocks: raw JSON arguments string. */
  arguments?: string
  /** `tool-result` blocks: nested content. */
  content?: readonly DeltaBlock[]
}

/** Structural message subset read off the `llm/stream` request snapshot. */
export interface DeltaMessage {
  role?: string
  content: readonly DeltaBlock[]
  source?: { kind?: string }
}

/** The per-trigger snapshot review decision (§4.1 steps 3-4). */
export type ReviewWindow =
  | { action: 'init' }
  | { action: 'reset' }
  | { action: 'skip'; reason: 'empty-window' | 'no-genuine-user' }
  | { action: 'review'; window: readonly DeltaMessage[] }

/** True when the message is genuine user input (source-less OR kind 'user') with ≥1 non-empty text block. */
export function isGenuineUser(message: DeltaMessage): boolean {
  if (message.source !== undefined && message.source.kind !== 'user') return false
  return message.content.some(block => block.type === 'text' && (block.text ?? '').length > 0)
}

/** Injected kinds are invisible to the advisor (§4.1 step 3). */
function isInjected(message: DeltaMessage): boolean {
  return message.source !== undefined && INJECTED_SOURCE_DENYLIST.includes(message.source.kind ?? '')
}

/** The cursor for a full snapshot (first observation / reset / advance). */
export function fullCursor(messages: readonly DeltaMessage[]): Cursor {
  return {
    count: messages.length,
    tail: messages.length > 0 ? JSON.stringify(messages[messages.length - 1]) : '',
  }
}

/** The tail anchor for the message at `count - 1`, or '' when count is 0. */
function tailAt(messages: readonly DeltaMessage[], count: number): string {
  return count > 0 ? JSON.stringify(messages[count - 1] ?? '') : ''
}

/**
 * The snapshot-window decision (§4.1 steps 3-4), in order:
 * init → reset-and-skip → filter → empty-window skip → no-genuine-user skip
 * → review. The caller advances the cursor to `fullCursor(snapshot)` on
 * `init`, `reset`, and `skip` — and immediately (before the async call) on
 * `review` — so a failed cheap-lane call loses its window rather than
 * double-billing the next one.
 */
export function reviewWindow(
  snapshot: readonly DeltaMessage[],
  cursor: Cursor | undefined,
): ReviewWindow {
  // First observation: cold/resumed history is never review-billed.
  if (cursor === undefined) return { action: 'init' }
  // History rewritten (compaction/rewind) → reset+skip.
  if (snapshot.length < cursor.count || tailAt(snapshot, cursor.count) !== cursor.tail) {
    return { action: 'reset' }
  }
  // Candidate window, filtered to drop injected kinds.
  const window = snapshot.slice(cursor.count).filter(message => !isInjected(message))
  // Empty window after filtering ⇒ advance cursor, skip.
  if (window.length === 0) return { action: 'skip', reason: 'empty-window' }
  // No genuine user message ⇒ advance cursor, skip (spend guard + wake-loop break).
  if (!window.some(isGenuineUser)) return { action: 'skip', reason: 'no-genuine-user' }
  return { action: 'review', window }
}

/** Args blob truncated at 2000 bytes (§4.1 render rule). */
function truncateArgs(args: string): string {
  return Buffer.byteLength(args, 'utf8') > MAX_TOOL_ARGS_BYTES
    ? `${Buffer.from(args, 'utf8').subarray(0, MAX_TOOL_ARGS_BYTES).toString('utf8')}…`
    : args
}

/** Render one content block (§4.1 render rule). */
function renderBlock(block: DeltaBlock): string {
  if (block.type === 'tool-call') {
    return `[assistant tool_use ${block.name ?? 'unknown'}] ${truncateArgs(block.arguments ?? '')}`
  }
  if (block.type === 'tool-result') {
    return (block.content ?? [])
      .filter(nested => nested.type === 'text')
      .map(nested => nested.text ?? '')
      .join('\n')
  }
  return block.text ?? ''
}

/** `[role] content` lines for one message: text blocks joined, tool blocks rendered. */
function renderMessage(message: DeltaMessage): string {
  const role = message.role ?? 'user'
  const textParts: string[] = []
  const toolLines: string[] = []
  for (const block of message.content) {
    if (block.type === 'tool-call' || block.type === 'tool-result') {
      const line = renderBlock(block)
      if (line.length > 0) toolLines.push(line)
    } else if (block.type === 'text') {
      textParts.push(block.text ?? '')
    }
  }
  const lines: string[] = []
  const text = textParts.join('\n')
  if (text.length > 0) lines.push(`[${role}] ${text}`)
  lines.push(...toolLines)
  return lines.join('\n')
}

/**
 * Render the delta newest-tailed (§4.1): over the byte cap, drop from the
 * OLDEST end and prepend `[truncated N older bytes]`.
 */
export function renderDelta(window: readonly DeltaMessage[]): string {
  const lines = window.flatMap(renderMessage).filter(line => line.length > 0)
  const total = Buffer.byteLength(lines.join('\n'), 'utf8')
  if (total <= MAX_DELTA_BYTES) return lines.join('\n')
  let truncatedBytes = 0
  let start = 0
  // Drop whole oldest lines until the remainder fits under the cap.
  while (start < lines.length) {
    truncatedBytes += Buffer.byteLength(lines[start] ?? '', 'utf8') + 1
    start += 1
    if (total - truncatedBytes <= MAX_DELTA_BYTES) break
  }
  const marker = `[truncated ${truncatedBytes} older bytes]`
  return [marker, ...lines.slice(start)].join('\n')
}
