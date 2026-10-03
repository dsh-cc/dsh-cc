/**
 * Append-only per-session TUS ledger (`<dshHome>/tool-use-summary/<sessionId>.jsonl`).
 *
 * One `appendFile` per row (context-crusher `SavingsLedger` pattern). All I/O
 * errors are swallowed: the ledger is observability and crash recovery, never
 * a tool-result dependency.
 *
 * @module @dsh-cc/tool-use-summary/ledger
 */

import { readdir, stat, rm, utimes, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { appendJsonl, readJsonl } from '@dsh-cc/sidecar-io'
import type { SummaryRow } from './types.ts'

/** Append one row; never throws. */
export async function appendLedgerRow(filePath: string, row: SummaryRow): Promise<void> {
  await appendJsonl(filePath, row)
}

/**
 * Pure reader for consumers: load the ok/skipped rows of one session's ledger
 * into a map keyed by callId. Tolerant of a truncated tail line (a torn final
 * write from a crash mid-append is skipped, not fatal).
 * @param dshHome - the DSH home root.
 * @param sessionId - session whose ledger to read.
 * @returns rows keyed by callId (empty when the file is absent).
 */
export async function loadSummaries(dshHome: string, sessionId: string): Promise<Map<string, SummaryRow>> {
  const out = new Map<string, SummaryRow>()
  const rows = await readJsonl<SummaryRow>(join(dshHome, 'tool-use-summary', `${sessionId}.jsonl`))
  for (const row of rows) {
    if (typeof row?.callId === 'string') out.set(row.callId, row)
  }
  return out
}

/**
 * Delete ledger files older than `retentionDays`. Runs out of any result hot
 * path — fire-and-forget at plugin mount (context-crusher sweep precedent).
 * @returns the number of files removed.
 */
export async function sweepLedgers(dshHome: string, retentionDays: number): Promise<number> {
  const dir = join(dshHome, 'tool-use-summary')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const file = join(dir, name)
    try {
      const info = await stat(file)
      if (info.mtimeMs < cutoff) {
        await rm(file)
        removed += 1
      }
    } catch {
      // Unreadable/unremovable file: skip it, never fail the sweep.
    }
  }
  return removed
}

/** Force an aged mtime on a ledger file (test seam: "fake mtime"). */
export async function ageLedgerFile(dshHome: string, sessionId: string, at: Date): Promise<void> {
  const file = join(dshHome, 'tool-use-summary', `${sessionId}.jsonl`)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, '', 'utf8')
  await utimes(file, at, at)
}
