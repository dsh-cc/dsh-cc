/**
 * JSONL ledger for prefix observations: one row per model call, appended to
 * `<dshHome>/cache-health/<projectKey>/<sessionId>.jsonl`. All I/O is
 * fire-and-forget — the llm/stream path must never await on it — and every
 * error is reported through the injected sink, never thrown.
 *
 * @module @dsh-cc/cache-health/ledger
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Hard cap of rows per session file; older rows are trimmed on overflow. */
export const LEDGER_MAX_ROWS = 2000

/** One ledger row (one JSON object per jsonl line). */
export interface LedgerRow {
  /** ISO timestamp of the observation. */
  readonly ts: string
  /** Seq of the last session event at observe time (the log's throughSeq). */
  readonly seq: number
  readonly provider: string
  readonly model: string
  readonly stableSegments: number
  readonly stablePrefixTokensEst: number
  readonly prefixChanged: boolean
  readonly driftSegmentIndex?: number
  readonly driftExcerpt?: string
  /** When set, the call is an auxiliary one (compaction / session-title). */
  readonly callPurpose?: string
}

/** Error sink (the plugin passes a warn-logger); never throws. */
export type LedgerErrorSink = (error: unknown) => void

/**
 * Append-only ledger store. One instance per mounted plugin; `root` is
 * `dshHomePath('cache-health')`. Row counts are tracked in memory from
 * process start (an on-disk file longer than the cap is trimmed on the
 * first post-start overflow check).
 */
// ponytail: in-memory row count ignores pre-existing file length until the
// first overflow; initialize from disk on first append if that ever matters.
export class CacheHealthLedger {
  private readonly counts = new Map<string, number>()

  constructor(
    readonly root: string,
    private readonly onError: LedgerErrorSink = () => {},
  ) {}

  /** Ledger file path for one session within a project. */
  pathFor(projectKey: string, sessionId: string): string {
    return join(this.root, projectKey, `${sessionId}.jsonl`)
  }

  /** Append one row as a FLOATING promise. Never await on the llm/stream path. */
  append(projectKey: string, sessionId: string, row: LedgerRow): void {
    const file = this.pathFor(projectKey, sessionId)
    void (async () => {
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, `${JSON.stringify(row)}\n`, 'utf8')
      const count = (this.counts.get(file) ?? 0) + 1
      this.counts.set(file, count)
      if (count > LEDGER_MAX_ROWS) await this.trim(file)
    })().catch((error) => {
      try {
        this.onError(error)
      } catch {
        // sink failure must never propagate
      }
    })
  }

  /** Read all rows of one session ledger; missing/corrupt file → []. */
  async read(projectKey: string, sessionId: string): Promise<LedgerRow[]> {
    const file = this.pathFor(projectKey, sessionId)
    try {
      const text = await readFile(file, 'utf8')
      const rows: LedgerRow[] = []
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          rows.push(JSON.parse(line) as LedgerRow)
        } catch {
          // skip corrupt line, keep the rest
        }
      }
      return rows
    } catch {
      return []
    }
  }

  /** Rewrite the file keeping only the newest LEDGER_MAX_ROWS rows. */
  private async trim(file: string): Promise<void> {
    const text = await readFile(file, 'utf8')
    const lines = text.split('\n').filter(line => line.trim() !== '')
    const kept = lines.slice(-LEDGER_MAX_ROWS)
    await writeFile(file, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8')
    this.counts.set(file, kept.length)
  }
}
