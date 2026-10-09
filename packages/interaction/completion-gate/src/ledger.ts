/**
 * The JSONL receipts ledger (plan
 * docs/plans/2026-10-09-runtime-verified-completion.md §3.2): one append-only
 * file per session under `<dshHome>/completion-gate/receipts/<sessionId>.jsonl`,
 * written DETACHED (fire-and-forget; forensics/dogfood-only — nudge evaluation
 * reads in-session events, never this file). Rows NEVER contain `head`.
 * Boot hygiene: one global sweep keeps the newest 100 session files.
 *
 * @module @dsh-cc/completion-gate/ledger
 */

import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Receipt } from './events.ts'

/** Files kept by the boot sweep (constant lives in code — §3.5 YAGNI). */
export const RETENTION_FILES = 100

/**
 * The hash-only ledger projection of a receipt: `head` is omitted entirely.
 */
export function ledgerRowOf(receipt: Receipt): Record<string, unknown> {
  const row: Record<string, unknown> = { ...receipt }
  delete row.head
  return row
}

/**
 * Fire-and-forget JSONL append (§3.2): mkdir-recursive first (node does not
 * create parents), then append one line. Never throws — failures go to the
 * debug sink.
 */
export function appendLedgerRow(file: string, row: Record<string, unknown>, debug: (msg: string) => void): void {
  const line = JSON.stringify(row) + '\n'
  void (async () => {
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, line, 'utf8')
  })().catch((error: unknown) => {
    debug(`completion-gate: ledger append failed: ${String(error)}`)
  })
}

/**
 * Keep the newest `keep` session files by mtime; unlink the rest. Returns the
 * kept file names (or undefined when the directory is absent).
 */
export async function sweepReceipts(dir: string, keep: number = RETENTION_FILES): Promise<string[] | undefined> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return undefined
  }
  const byMtime: { name: string; mtime: number }[] = []
  for (const name of names) {
    try {
      const mtime = (await stat(join(dir, name))).mtimeMs
      byMtime.push({ name, mtime })
    } catch {
      // Vanished mid-sweep: skip.
    }
  }
  byMtime.sort((a, b) => b.mtime - a.mtime)
  const kept = byMtime.slice(0, keep)
  for (const stale of byMtime.slice(keep)) {
    try {
      await unlink(join(dir, stale.name))
    } catch {
      // Already gone: fine.
    }
  }
  return kept.map(entry => entry.name)
}

/** The per-session ledger file path. */
export function ledgerFileFor(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.jsonl`)
}
