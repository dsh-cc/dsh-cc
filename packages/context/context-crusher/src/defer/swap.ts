/**
 * The deferred swap pass (design §3.3): one non-awaiting critical section
 * per eligible entry, executed at the `agent/pre-step` boundary. Mirrors the
 * microcompact replacement shape exactly (compaction-micro index.ts
 * 270-295): a `compaction/prune` shadow-price row debiting the token meter,
 * immediately followed by the `tool/result` replacement carrying
 * `surfaceOp: replace` + `sourceEventSeqs`, with every non-content field of
 * the original block preserved.
 *
 * Staleness is re-checked against the live surface inside the same section
 * (locate by callId — the sole locator — then byte-equality of the body), so
 * an in-flight request or a microcompact pass cannot interleave with a swap.
 *
 * @module @dsh-cc/context-crusher/defer/swap
 */

import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { Message, ToolResultBlock } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionSeq, ToolResultMessage } from '@deepseek-ai/dsh-session'
// Type-only: the `compaction/prune` shadow-price SessionEventMap merge.
import type {} from '@deepseek-ai/dsh-compaction'
import { joinTextBlocks } from './counter.ts'
import { evaluateDeferGate } from './gate.ts'
import type { DeferGateFacts, ResidentEntry } from './residents.ts'

export interface SwapInput {
  readonly session: Session
  readonly entry: ResidentEntry
  /** Stored original full text (fetched BEFORE the critical section). */
  readonly fullText: string
  /** Standard compressed body + `buildMarker(...)` trailer. */
  readonly stubText: string
  /** `false` in dry-run: evaluate everything, append nothing (§3.6). */
  readonly apply: boolean
  readonly margin: number
  readonly remainingRequestsEstimate: number
  readonly urgencyTokens?: number
  readonly sessionTokens?: number
  readonly contextWindow?: number
  readonly estimateMessage: (message: Message) => number
}

export type SwapResult =
  | { readonly outcome: 'applied' | 'dry-run' | 'gate-failed'; readonly gate: DeferGateFacts }
  | { readonly outcome: 'stale' }

/** Locate the current surface `tool/result` event by callId (sole locator). */
export function locateResultEvent(
  session: Session,
  callId: ResidentEntry['callId'],
): { seq: SessionSeq; event: SessionEvent<'tool/result'> } | undefined {
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'tool/result') continue
    if (String(event.data.message.source.callId) === String(callId)) return { seq, event }
  }
  return undefined
}

/**
 * Σ estimateMessage over surface nodes AFTER `seq` — the suffix the prompt
 * cache would reprice if the entry were swapped now (§3.4).
 */
export function suffixTokensAfter(
  session: Session,
  seq: SessionSeq,
  estimateMessage: (message: Message) => number,
): number {
  let sum = 0
  let seen = false
  for (const node of session.surface.nodes) {
    if (node === seq) {
      seen = true
      continue
    }
    if (!seen) continue
    const event = session.eventAt(node)
    if (event === undefined) continue
    const message = deriveEventMessage(event)
    if (message !== null) sum += estimateMessage(message)
  }
  return sum
}

/**
 * Evaluate and (when `apply`) commit one entry's swap. Synchronous: callers
 * must fetch the stored text and build the stub BEFORE calling, so the
 * staleness re-check and the two appends happen without yielding.
 */
export function attemptSwap(input: SwapInput): SwapResult {
  const { session, entry } = input
  const located = locateResultEvent(session, entry.callId)
  if (located === undefined) return { outcome: 'stale' }
  const { seq, event } = located
  const message = event.data.message
  const first = message.content[0]
  const resultBlock: ToolResultBlock | undefined = first?.type === 'tool-result' ? first : undefined
  const body = resultBlock === undefined ? undefined : joinTextBlocks(resultBlock.content)
  if (body !== input.fullText) return { outcome: 'stale' }

  const suffixTokens = suffixTokensAfter(session, seq, input.estimateMessage)
  const gate = evaluateDeferGate({
    tokensSaved: entry.tokensSaved,
    remainingRequestsEstimate: input.remainingRequestsEstimate,
    margin: input.margin,
    suffixTokens,
    ...(input.urgencyTokens !== undefined ? { urgencyTokens: input.urgencyTokens } : {}),
    ...(input.sessionTokens !== undefined ? { sessionTokens: input.sessionTokens } : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
  })
  const facts: DeferGateFacts = {
    sentCount: entry.sentCount,
    suffixTokens,
    projectedSavings: gate.projectedSavings,
    margin: input.margin,
    remainingRequestsEstimate: Math.max(1, input.remainingRequestsEstimate),
    urgencyOverride: gate.urgencyOverride,
  }
  if (!gate.pass) return { outcome: 'gate-failed', gate: facts }
  if (!input.apply) return { outcome: 'dry-run', gate: facts }

  // Preserve every non-content field of the original tool-result block (type,
  // toolCallId, isError, plus future additions) — the "may change only
  // content" surface invariant.
  const replacementBlock: ToolResultBlock = resultBlock === undefined
    ? { type: 'tool-result', toolCallId: message.source.callId, content: [{ type: 'text', text: input.stubText }] }
    : { ...resultBlock, content: [{ type: 'text', text: input.stubText }] }
  const replacementMessage = freezeMessage<ToolResultMessage>({
    ...message,
    content: [replacementBlock],
  })
  // Shadow-price protocol: the metering event and its replacement are
  // appended synchronously adjacent so the token meter subtracts the
  // shadowed node's heuristic price exactly once.
  session.append('compaction/prune', {
    shadowedRange: { start: seq, end: seq },
    shadowedSeqs: [seq],
    shadowedTokenCount: input.estimateMessage(message),
  })
  session.append('tool/result', {
    ...event.data,
    message: replacementMessage,
  }, {
    surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
    sourceEventSeqs: [seq],
  })
  return { outcome: 'applied', gate: facts }
}
