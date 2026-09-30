/**
 * Compact-fold helpers: duck-typed reads over the compact checkpoint shape
 * and pure transcript-row operations shared by the fold and the driver's
 * command-echo path. UI-layer only — no harness imports.
 * @module @dsh-cc/tui/compact-fold
 */
import type { TranscriptRow } from './store.ts'

/** Tags wrapping the structured summary inside a compact checkpoint message. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/**
 * Duck-type the compact checkpoint's UserMessage source. Accepted spellings:
 * the harness named kinds (`compact-checkpoint`, and `compact-basic` from
 * `dsh-compaction-basic`), the pre-conversion legacy shape
 * `{ kind: 'plugin', plugin: 'compact' }`, and the `plugin:<name>` spellings
 * a resumed v3 session can carry (the v3→v4 converter rewrites unknown
 * producers to `plugin:<original name>` — e.g. `plugin:compact`-style).
 * Unknown shapes (absent, non-object, other kinds) are not checkpoints.
 */
export function isCompactCheckpointSource(source: unknown): boolean {
  if (source === null || typeof source !== 'object') return false
  const record = source as { kind?: unknown; plugin?: unknown }
  if (record.kind === 'compact-checkpoint' || record.kind === 'compact-basic') return true
  if (typeof record.kind === 'string' && /^plugin:\S*compact/.test(record.kind)) return true
  return record.kind === 'plugin' && record.plugin === 'compact'
}

/**
 * Join the text blocks of a checkpoint message's content and extract the
 * body between the summary tags (trimmed). Missing/misordered tags yield ''.
 */
export function extractCompactSummary(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as { type?: unknown; text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  const text = parts.join('\n')
  const start = text.indexOf(SUMMARY_OPEN_TAG)
  const end = text.indexOf(SUMMARY_CLOSE_TAG)
  if (start === -1 || end === -1 || end < start) return ''
  return text.slice(start + SUMMARY_OPEN_TAG.length, end).trim()
}

/**
 * Drop rows whose `seq` tag falls inside the inclusive replaced range.
 * Untagged rows (historical folds without surface metadata) always stay.
 */
export function dropRowsInRange(
  rows: readonly TranscriptRow[],
  start: number,
  end: number,
): TranscriptRow[] {
  return rows.filter(row => {
    const seq = (row as { seq?: unknown }).seq
    return typeof seq !== 'number' || seq < start || seq > end
  })
}

/**
 * Whether a host-command result should still echo as a status row. A
 * successful `/compact` already painted its collapsible compact boundary —
 * echoing `Compacted N history items…` on top would duplicate it. Errors
 * and successes without a compact row always echo.
 */
export function shouldEchoCommandResult(
  result: { kind?: string; text?: string; sourceEventSeq?: number } | undefined,
  rows: readonly TranscriptRow[],
): boolean {
  if (result === undefined) return false
  if (result.kind === 'success' && rows.some(row => row.kind === 'compact')) return false
  return true
}
