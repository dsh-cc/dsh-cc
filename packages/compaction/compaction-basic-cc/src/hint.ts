/**
 * Per-agent /compact preservation hints.
 *
 * The `/compact [instructions]` command parks the free-text hint here keyed
 * by the invoking agent; the CC compaction engine's `summarize()` override
 * takes (and clears) it when the summarizer input is built, appending the
 * hint as one extra user message so the summary preserves what the user
 * asked for. WeakMap keying means hints never leak across agents and die
 * with the agent object.
 * @module @dsh-cc/compaction-basic-cc/hint
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

const hints = new WeakMap<object, string>()

/** Park `hint` for `agent`, replacing any previous hint (last write wins). */
export function setCompactHint(agent: object, hint: string): void {
  hints.set(agent, hint)
}

/** Take and clear the parked hint for `agent`; undefined when none. */
export function takeCompactHint(agent: object): string | undefined {
  const hint = hints.get(agent)
  if (hint === undefined) return undefined
  hints.delete(agent)
  return hint
}

/**
 * Append the hint as one extra user message at the end of the summarizer
 * input's replayed messages. An empty/whitespace hint returns the input
 * unchanged (same reference), so a bare /compact is byte-identical.
 */
export function applyCompactHint<T extends { messages: readonly unknown[] }>(
  input: T,
  hint: string,
): T {
  if (hint.trim().length === 0) return input
  return {
    ...input,
    messages: [
      ...input.messages,
      createUserMessage({
        content: [{ type: 'text', text: `Additional preservation instructions from the user:\n${hint}` }],
        source: { kind: 'user' },
      }),
    ],
  }
}
