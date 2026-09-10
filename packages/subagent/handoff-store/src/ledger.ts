/**
 * Append-only handoff ledger (`<dshHome>/handoff/ledger.jsonl`).
 *
 * One `appendFile` per row (rows are small; appends are atomic enough even
 * when sibling children interleave rows). The ledger is a rebuildable
 * observability index, NOT on the read path — `handoff_get` never touches it.
 * All I/O errors are swallowed: a failed row must never degrade a put.
 *
 * @module @dsh-cc/handoff-store/ledger
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { HandoffLedgerRow } from './types.ts'

export class HandoffLedger {
  constructor(private readonly filePath: string) {}

  /** Append one row; never throws. */
  async append(row: HandoffLedgerRow): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await appendFile(this.filePath, `${JSON.stringify(row)}\n`, 'utf8')
    } catch {
      // Best-effort observability; never surface into the tool waterfall.
    }
  }
}
