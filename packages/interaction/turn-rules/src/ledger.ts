/**
 * Per-session fired-state ledger (plan docs/plans/2026-09-23-turn-rules.md
 * §4.6): `$DSH_HOME/turn-rules/<sessionId>.json`, flat by session id (session
 * ids are globally unique). Schema:
 * `{ version: 1, turnCounter, fired: { "<ruleKey>": <firedAtTurn> } }`.
 * Writes are atomic (same-directory temp file + rename) and never throw — the
 * ledger is durability only (resume/compaction rehydration); the in-memory
 * per-session map is the authoritative double-fire gate.
 *
 * @module
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** The durable fired-state record for one session. */
export interface TurnRulesLedger {
  version: 1
  turnCounter: number
  /** ruleKey → the turn counter value at which the rule last fired. */
  fired: Record<string, number>
}

/** An empty ledger. */
export function emptyLedger(): TurnRulesLedger {
  return { version: 1, turnCounter: 0, fired: {} }
}

/** The ledger file for one session. */
export function ledgerFileFor(dshHome: string, sessionId: string): string {
  return join(dshHome, 'turn-rules', `${sessionId}.json`)
}

/**
 * Load one session's ledger; `undefined` when absent or malformed (a fresh
 * session simply has no file).
 */
export async function loadLedger(dshHome: string, sessionId: string): Promise<TurnRulesLedger | undefined> {
  let raw: string
  try {
    raw = await readFile(ledgerFileFor(dshHome, sessionId), 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as TurnRulesLedger
    if (parsed?.version !== 1 || typeof parsed.turnCounter !== 'number') return undefined
    if (typeof parsed.fired !== 'object' || parsed.fired === null) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Persist one session's ledger atomically (temp file + rename, handoff-store
 * pattern). Never throws: durability must not poison a listener.
 */
export async function writeLedger(dshHome: string, sessionId: string, ledger: TurnRulesLedger): Promise<void> {
  const file = ledgerFileFor(dshHome, sessionId)
  try {
    await mkdir(dirname(file), { recursive: true })
    // Atomic write: same-directory temp file + rename (handoff-store pattern).
    const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`
    await writeFile(tmp, JSON.stringify(ledger), 'utf8')
    await rename(tmp, file)
  } catch {
    // Durability only; never surface into a hot path.
  }
}
