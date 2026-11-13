/**
 * The shared append sink for input-governance ledgers — the writer docs 1 and
 * 7 reuse instead of rolling their own. One JSONL row per line under
 * `<dshHome>/input-ledger/<projectKey>/<encodeSegment(sessionId)>.jsonl`;
 * when a session file reaches its row cap it is renamed to `<file>.1`
 * (previous `.1` clobbered) and a fresh file starts.
 *
 * Pure module state only — no cordis context — so offline tooling (docs 5/8)
 * can use the same writer. No fsync: a torn final line is expected and
 * tolerated by readers (sidecar-io contract).
 *
 * @module @dsh-cc/input-ledger/sink
 */

import { rename, rm } from 'node:fs/promises'
import { appendJsonl, encodeSegment, jsonlPath } from '@dsh-cc/sidecar-io'
import type { LedgerRow } from './rows.ts'

/** Default row cap per session file (cache-health precedent). */
export const DEFAULT_MAX_ROWS_PER_FILE = 2000

/** dsh-home directory this package writes under. */
export const LEDGER_DIR_NAME = 'input-ledger'

/** Error sink for rows lost to a failed append. */
export type LedgerErrorSink = (error: unknown) => void

let droppedRows = 0

/**
 * In-process write health: rows lost to a failed append since process start.
 * A fresh object each call, so callers cannot mutate the counter.
 */
export function getLedgerHealth(): { droppedRows: number } {
  return { droppedRows }
}

/** Rows written per file since the last rotation (rotation trigger). */
const rowCounts = new Map<string, number>()

/** Per-file write chain: serializes appends so the row count cannot race. */
const writeChains = new Map<string, Promise<void>>()

/**
 * Path of one session's ledger file.
 * @param dshHome - the harness home directory root.
 * @param projectKey - short hash of the session cwd (sidecar-io convention).
 * @param sessionId - raw session id; encoded as a single safe path segment.
 */
export function sessionLedgerPath(dshHome: string, projectKey: string, sessionId: string): string {
  return jsonlPath(dshHome, LEDGER_DIR_NAME, projectKey, `${encodeSegment(sessionId)}.jsonl`)
}

/**
 * Append one row, rotating first when the file is already at its row cap.
 * Never throws: a write failure increments {@link getLedgerHealth}'s
 * `droppedRows`, is handed to `onError` when supplied, and resolves.
 *
 * @param filePath - target from {@link sessionLedgerPath}; `undefined` (no
 *   dshHome on the host) is a no-op, so callers can pass a missing home
 *   straight through.
 * @param row - the row to persist.
 * @param onError - optional extra sink for the swallowed error.
 * @param maxRowsPerFile - row cap before rotation; defaults to
 *   {@link DEFAULT_MAX_ROWS_PER_FILE} and is narrowed by the
 *   `cc-input-ledger.max-rows-per-file` setting.
 */
export async function appendLedgerRow(
  filePath: string | undefined,
  row: LedgerRow,
  onError?: LedgerErrorSink,
  maxRowsPerFile: number = DEFAULT_MAX_ROWS_PER_FILE,
): Promise<void> {
  if (filePath === undefined) return
  const target = filePath
  const cap = rowsCapOf(maxRowsPerFile)
  const write = (): Promise<void> => writeRow(target, row, cap, onError)
  const prev = writeChains.get(target) ?? Promise.resolve()
  const next = prev.then(write, write)
  writeChains.set(target, next)
  await next
}

/** Coerce a caller-supplied row cap: a non-finite or sub-1 value falls back to the default. */
function rowsCapOf(maxRowsPerFile: number): number {
  if (!Number.isFinite(maxRowsPerFile)) return DEFAULT_MAX_ROWS_PER_FILE
  const cap = Math.trunc(maxRowsPerFile)
  return cap < 1 ? DEFAULT_MAX_ROWS_PER_FILE : cap
}

/** One serialized append; the only place the rotation rule is applied. */
async function writeRow(
  filePath: string,
  row: LedgerRow,
  maxRowsPerFile: number,
  onError?: LedgerErrorSink,
): Promise<void> {
  let failed = false
  const report = (error: unknown): void => {
    failed = true
    droppedRows += 1
    if (onError === undefined) return
    try {
      onError(error)
    } catch {
      // The extra sink is best-effort too.
    }
  }
  try {
    let count = rowCounts.get(filePath) ?? 0
    if (count >= maxRowsPerFile && (await rotate(filePath))) count = 0
    await appendJsonl(filePath, row, { repairTail: true, onError: report })
    if (!failed) rowCounts.set(filePath, count + 1)
  } catch (error) {
    // appendJsonl itself never throws; belt-and-braces for the rotation path.
    report(error)
  }
}

/**
 * Rename the capped session file to `<file>.1`, clobbering a previous
 * archive. A missing or unmovable file leaves the count at the cap, so the
 * next append retries rather than growing the live file forever.
 *
 * @returns true when the file was moved and a fresh one should start.
 */
async function rotate(filePath: string): Promise<boolean> {
  const archive = `${filePath}.1`
  try {
    await rm(archive, { force: true })
    await rename(filePath, archive)
    return true
  } catch {
    return false
  }
}
