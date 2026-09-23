/**
 * Owned journal line format for the workflow resume journal (design §3.3):
 * one JSON line per settled child, written by the journal provider and
 * parsed at resume time. The provider (packages/subagent/workflow-journal)
 * imports these helpers against the seam this module defines.
 * @module @dsh-cc/tool-workflow/journal-lines
 */

/** One settled-child journal line. */
export interface JournalLine {
  /** 1-based provider arrival index (== worker seq, design §2 strong form). */
  seq: number
  /** fnv1a32 hex of the canonicalized request triple. */
  hash: string
  /** Verbatim harness SubagentStopReason; only 'completed' is replayable. */
  status: string
  /** Exactly the {output, structured?, stopReason} projection (design F4). */
  result: unknown
}

/** One line, no trailing-newline handling — the writer owns framing. */
export function serializeJournalLine(line: JournalLine): string {
  return JSON.stringify({ seq: line.seq, hash: line.hash, status: line.status, result: line.result })
}

/**
 * Parse journal text. A trailing unparseable LAST line is dropped silently
 * (crash-tail tolerance); any unparseable non-last line or missing/invalid
 * required field marks the whole journal corrupt (= fail-open live replay).
 * Empty/missing text => { lines: [], corrupt: false }.
 */
export function parseJournal(text: string): { lines: JournalLine[]; corrupt: boolean } {
  if (text.length === 0) return { lines: [], corrupt: false }
  const parts = text.split('\n')
  const last = parts.length - 1
  const lines: JournalLine[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    // A final empty fragment is just the writer's trailing newline framing.
    if (part.length === 0 && i === last) continue
    let line: JournalLine
    try {
      line = JSON.parse(part) as JournalLine
    } catch {
      if (i === last) return { lines, corrupt: false }
      return { lines: [], corrupt: true }
    }
    if (
      typeof line.seq !== 'number' || !Number.isInteger(line.seq) || line.seq < 1
      || typeof line.hash !== 'string'
      || typeof line.status !== 'string'
      || !('result' in line) || line.result === undefined
    ) return { lines: [], corrupt: true }
    lines.push({ seq: line.seq, hash: line.hash, status: line.status, result: line.result })
  }
  return { lines, corrupt: false }
}
