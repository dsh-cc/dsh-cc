/**
 * Consumer B (design doc §5.4): TUS digest substitution into the upstream
 * `@deepseek-ai/dsh-compaction-basic` summarizer input.
 *
 * PROBE VERDICT (test 9, tests/tus-probe.spec.ts): POSITIVE. The upstream
 * `SummarizationInput` is `{ tools?, messages: readonly Message[] }` — the
 * replayed conversation surface (packages/compaction/compaction-basic
 * src/summarizer.ts). Every tool result arrives as a dsh-llm
 * `ToolResultMessage` carrying `source.callId` (plus the block-level
 * `ToolResultBlock.toolCallId`), so per tool-result callId identity EXISTS
 * and substitution is implemented here rather than documented away.
 *
 * Substitution: qualifying tool results (an ok TUS row with a summary for the
 * message's `source.callId`, body not already a context-crusher stub) are
 * replaced with the §5.4 untrusted-framed digest. No rows → the input is
 * returned unchanged (same reference → byte-identical upstream call).
 *
 * @module @dsh-cc/compaction-basic-cc/tus
 */

import { loadSummaries, isCrusherStub, tusFramedSummary } from '@dsh-cc/tool-use-summary'
import type { SummaryRow } from '@dsh-cc/tool-use-summary'
import type { ContentBlock, Message, ToolResultBlock } from '@deepseek-ai/dsh-llm'

/**
 * Durable probe record (capability-entry anchor). POSITIVE verdict: per
 * tool-result callId identity exists on the upstream summarize input
 * (`ToolResultMessage.source.callId` / `ToolResultBlock.toolCallId`), so the
 * §5.4 substitution is implemented instead of documented away.
 */
export const TUS_CONSUMER_PROBE =
  'Probe verdict: POSITIVE — the upstream @deepseek-ai/dsh-compaction-basic '
  + 'SummarizationInput is { tools?, messages: readonly Message[] }; tool results '
  + 'are ToolResultMessage blocks individually identifiable by source.callId '
  + '(and ToolResultBlock.toolCallId), so TUS digest substitution is implemented '
  + 'in applyTusSummaries (compaction-basic-cc).'

/** Minimal structural view of the upstream `SummarizationInput`. */
interface SummarizationInputLike {
  readonly messages: readonly Message[]
}

/** Plain text of a tool-result block. */
function plainText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function qualify(row: SummaryRow | undefined): row is SummaryRow & { summary: string } {
  return row !== undefined && row.status === 'ok' && typeof row.summary === 'string'
}

/**
 * Substitute qualifying tool-result blocks in a summarizer input with the
 * framed TUS digest (§5.4). Absent home/rows → the input unchanged (same
 * reference). Crusher stubs are never substituted (§5.6). Never throws.
 */
export async function applyTusSummaries<T extends SummarizationInputLike>(
  input: T,
  dshHome: string | undefined,
  sessionId: string,
): Promise<T> {
  try {
    if (dshHome === undefined || sessionId.length === 0) return input
    const rows = await loadSummaries(dshHome, sessionId)
    if (rows.size === 0) return input
    let changed = false
    const messages = input.messages.map((message) => {
      if (message.source?.kind !== 'tool') return message
      const block = message.content[0] as ToolResultBlock | undefined
      if (block?.type !== 'tool-result') return message
      const row = rows.get(String(message.source.callId))
      if (!qualify(row) || isCrusherStub(plainText(block.content))) return message
      return {
        ...message,
        content: [{
          ...block,
          content: [{ type: 'text', text: tusFramedSummary(row) }],
        }] as unknown as typeof message.content,
      }
    })
    changed = messages.some((message, index) => message !== input.messages[index])
    if (!changed) return input
    return { ...input, messages } as T
  } catch {
    return input
  }
}
