/**
 * Per-session run journal (plan docs/plans/2026-09-23-advisor-watchdog.md
 * §4.6): one JSON line per actually-attempted run, appended to
 * `$DSH_HOME/advisor/<sessionId>.jsonl` — flat per-session file under
 * `$DSH_HOME` (turn-rules ledger posture: no projectKey segment, fail-soft
 * IO). The journal is dogfood telemetry only; nothing reads it at runtime.
 *
 * Line fields (§4.6, verbatim): ts, turn, alias, model, inheritedRoute, ok,
 * reason, durationMs, deltaMessages, deltaBytes, notesIn, notesOut, drops,
 * usage (reserved, always null in v0 — `SideQueryResult` surfaces no token
 * usage; see §7 open thread).
 *
 * @module
 */

import { mkdir, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DropCounters } from './guard.ts'

/** One journal line, exactly the §4.6 field list. */
export interface AdvisorJournalEntry {
  ts: number
  /** capturedTurn at capture time. */
  turn: number
  alias: string
  /** The resolveAlias route's model id; null when unrouted, unset, or inherited. */
  model: string | null
  inheritedRoute: boolean
  ok: boolean
/** On failure only; absent on success (exactOptionalPropertyTypes-safe at the call site via a union). */
  reason: 'unrouted' | 'timeout' | 'error' | 'empty' | undefined
  durationMs: number
  deltaMessages: number
  deltaBytes: number
  notesIn: number
  notesOut: number
  drops: DropCounters
  /** Reserved: N/A in v0 (§4.6). */
  usage: null
}

/** The journal file for one session. */
export function journalFileFor(dshHome: string, sessionId: string): string {
  return join(dshHome, 'advisor', `${sessionId}.jsonl`)
}

/** Append one journal line. Never throws: observability must not poison a listener. */
export async function appendJournal(dshHome: string, sessionId: string, entry: AdvisorJournalEntry): Promise<void> {
  try {
    const file = journalFileFor(dshHome, sessionId)
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // Dogfood data only; never surface into a hot path.
  }
}
