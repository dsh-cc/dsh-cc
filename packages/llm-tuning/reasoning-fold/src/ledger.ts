/**
 * Probe record + append-only fold ledger (`<dshHome>/reasoning-fold/<sessionId>.jsonl`).
 *
 * Ledger growth is bounded by session count (one file per session); rotate/cap
 * only when reasoning-fold/ exceeds ~10MB or Stage 1 ships.
 *
 * SavingsLedger idiom (context-crusher/src/ledger.ts): one appendFile per row,
 * all I/O errors swallowed — the ledger is observability and must never
 * degrade a model call.
 *
 * @module @dsh-cc/reasoning-fold/ledger
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

/**
 * Per-call probe record. A LOCAL const inside one `llm/stream` listener
 * invocation — never shared mutable state across calls.
 */
export interface FoldRecord {
  readonly provider: string
  readonly model: string
  readonly sessionId: string
  readonly purpose: 'compaction' | 'session-title' | null
  reasoningBytes: number
  textBytes: number
  /** Full usage-chunk capture; a call with no usage chunk leaves this unset. */
  usage?: TokenUsage
}

/** One JSONL ledger row (`usage` omitted when the call carried no usage chunk). */
export interface LedgerRow {
  readonly ts: string
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly purpose: 'compaction' | 'session-title' | null
  readonly reasoningBytes: number
  readonly textBytes: number
  readonly usage?: TokenUsage
}

/**
 * Observe one upstream chunk into the record (READ-ONLY: mutates only the
 * record, never the chunk). Byte counts are UTF-8 so multibyte deltas count
 * by wire bytes, not code points.
 */
export function observeChunk(record: FoldRecord, chunk: StreamChunk): void {
  switch (chunk.type) {
    case 'reasoning-delta':
      record.reasoningBytes += Buffer.byteLength(chunk.text, 'utf8')
      break
    case 'text-delta':
      record.textBytes += Buffer.byteLength(chunk.text, 'utf8')
      break
    case 'usage':
      // Spread copy: detach from the upstream chunk (frozen or otherwise).
      record.usage = { ...chunk.usage }
      break
    default:
      // block-start/block-end/tool-call-delta/finish are ignored.
      break
  }
}

/**
 * Append one ledger row; never throws. `usage` is omitted from the row when
 * the call carried no usage chunk.
 */
export async function appendLedgerRow(filePath: string, record: FoldRecord): Promise<void> {
  try {
    const row: LedgerRow = {
      ts: new Date().toISOString(),
      sessionId: record.sessionId,
      provider: record.provider,
      model: record.model,
      purpose: record.purpose,
      reasoningBytes: record.reasoningBytes,
      textBytes: record.textBytes,
      ...record.usage === undefined ? {} : { usage: record.usage },
    }
    await mkdir(dirname(filePath), { recursive: true })
    await appendFile(filePath, `${JSON.stringify(row)}\n`, 'utf8')
  } catch {
    // Best-effort observability; never surface into the model-call waterfall.
  }
}
