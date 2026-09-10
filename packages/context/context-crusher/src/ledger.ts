/**
 * Append-only savings ledger (`<dshHome>/ccr/savings.jsonl`).
 *
 * One `appendFile` per row (rows are small, appends are atomic enough for
 * single-process use). sessionId lives ONLY here — never in a store path.
 * All I/O errors are swallowed: the ledger is observability, and a failed row
 * must never degrade a tool result.
 *
 * @module @dsh-cc/context-crusher/ledger
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { LedgerRow } from './types.ts'

export class SavingsLedger {
  constructor(private readonly filePath: string) {}

  /** Append one row; never throws. */
  async append(row: LedgerRow): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await appendFile(this.filePath, `${JSON.stringify(row)}\n`, 'utf8')
    } catch {
      // Best-effort observability; never surface into the tool waterfall.
    }
  }
}
