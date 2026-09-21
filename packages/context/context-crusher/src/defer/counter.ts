/**
 * First-chunk send counting for deferred residents (design §3.2).
 *
 * A resident entry counts as sent when a provider request produces its FIRST
 * chunk and the request's `options.messages` contain a tool-result block
 * whose text fingerprint (sha256 first 16 hex — the same shape as the store
 * hash) matches the stored full text. Counting at first chunk — not request
 * start — excludes attempts that fail before reaching the provider.
 *
 * Purpose filtering is an ALLOWLIST: only main-loop requests count
 * (`purpose` undefined; the harness purpose union is closed to
 * `'compaction' | 'session-title'`). Subagent fan-outs are excluded as a
 * fingerprint side effect (fresh history never contains the resident); the
 * fork-inheriting corner is closed by requiring `options.sessionId` to be an
 * owning session id.
 *
 * @module @dsh-cc/context-crusher/defer/counter
 */

import type { ContentBlock, GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import { shortHash } from '../store.ts'

/**
 * Join text blocks; returns undefined when any block is non-text. Same rule
 * as the crusher's insertion-time text extraction, so the fingerprint of a
 * live tool-result block equals the store hash of the original.
 */
export function joinTextBlocks(blocks: readonly ContentBlock[]): string | undefined {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type !== 'text') return undefined
    parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Fingerprints of every fully-textual tool-result block in one outbound
 * prompt. A request that contains the same resident twice still counts once
 * (Set semantics).
 */
export function toolResultFingerprints(messages: readonly Message[]): Set<string> {
  const out = new Set<string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'tool-result') continue
      const text = joinTextBlocks(block.content)
      if (text !== undefined) out.add(shortHash(text))
    }
  }
  return out
}

/**
 * The counting guard: main-loop purpose allowlist AND an owning session id.
 * `owningSessionIds` is the in-memory set of sessions with defer state —
 * never the ledger (§3.5 keeps the ledger session-id-free).
 */
export function shouldCountRequest(
  options: GenerateOptions,
  owningSessionIds: ReadonlySet<string>,
): boolean {
  if (options.purpose !== undefined) return false
  if (options.sessionId === undefined) return false
  return owningSessionIds.has(String(options.sessionId))
}

/**
 * Wrap one provider stream so `onFirstChunk` fires exactly when the first
 * chunk is observed. A stream that throws before its first yield counts ZERO
 * (Phase-0 pin) and the error propagates untouched to the caller.
 */
export function wrapStreamWithCounting(
  options: GenerateOptions,
  stream: AsyncIterable<StreamChunk>,
  onFirstChunk: (options: GenerateOptions) => void,
): AsyncIterable<StreamChunk> {
  return (async function* () {
    let counted = false
    for await (const chunk of stream) {
      if (!counted) {
        counted = true
        onFirstChunk(options)
      }
      yield chunk
    }
  })()
}
