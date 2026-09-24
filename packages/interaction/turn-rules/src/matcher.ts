/**
 * Pure matching functions (plan docs/plans/2026-09-23-turn-rules.md §4.4):
 * the bounded unit serialization, UTF-8 truncation, and the once/after-gap
 * arithmetic. No I/O, no session state.
 *
 * @module
 */

/** Injected source kinds whose messages NEVER feed the prompt-channel match (recall.ts idiom; self-feed prevention). */
export const INJECTED_SOURCE_DENYLIST: readonly string[] = [
  'memory',
  'cc-subagent-children',
  'cc-workflow-completion',
  'turn-rules',
]

/** This plugin's own injected source kind. */
export const TURN_RULES_SOURCE_KIND = 'turn-rules'

/**
 * UTF-8-truncate to the first `maxBytes` bytes: the regex runs only over the
 * truncated buffer (§4.4). Operates at the byte level, so a multi-byte
 * character split at the boundary degrades to a replacement char — harmless
 * for pattern matching.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
}

/** Text blocks of a content list, joined by newline (non-text blocks skipped). */
function textBlocks(content: readonly { type: string; text?: string }[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

/**
 * The tool-channel matching unit (§4.4): `JSON.stringify(arguments ?? {})` +
 * `'\n'` + the joined text blocks of the accept's `content` rewrite (falling
 * back to the original result content when the accept carries none), UTF-8
 * truncated to `maxResultBytes`. Tool name, isError, and call id are NOT part
 * of the matched text.
 */
export function buildToolUnit(
  args: unknown,
  content: readonly { type: string; text?: string }[],
  maxBytes: number,
): string {
  const unit = `${JSON.stringify(args ?? {})}\n${textBlocks(content)}`
  return truncateUtf8(unit, maxBytes)
}

/**
 * The prompt-channel candidate text (§4.3 step 2): joined text blocks of
 * messages whose `source` is absent or whose `source.kind` is not in the
 * denylist — a message with no source is user input. UTF-8 truncated.
 */
export function buildPromptCandidate(
  messages: ReadonlyArray<{ content: readonly { type: string; text?: string }[]; source?: { kind?: string } }>,
  maxBytes: number,
): string {
  const candidate = messages
    .filter(message => message.source === undefined
      || !INJECTED_SOURCE_DENYLIST.includes(message.source.kind ?? ''))
    .map(message => textBlocks(message.content))
    .join('\n')
  return truncateUtf8(candidate, maxBytes)
}

/**
 * Fire decision for one rule (§4.6): `once` fires when never fired;
 * `after-gap` re-arms exactly at `turnCounter - firedAt >= repeatGap`.
 * @param firedAt - the turn counter value at the last fire, `undefined` when never.
 * @param turnCounter - the session's current turn counter.
 * @param repeat - the rule's repeat policy.
 * @param repeatGap - the rule's re-arm gap (used under `after-gap`).
 */
export function shouldFire(
  firedAt: number | undefined,
  turnCounter: number,
  repeat: 'once' | 'after-gap',
  repeatGap: number,
): boolean {
  if (firedAt === undefined) return true
  return repeat === 'after-gap' && turnCounter - firedAt >= repeatGap
}
