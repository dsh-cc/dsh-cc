/**
 * Emission guard (plan docs/plans/2026-09-23-advisor-watchdog.md §4.4),
 * ported from oh-my-pi's advisor emission-guard (Appendix A). Applied in the
 * FIXED order — severity, normalized denylist, quarantine, dedupe, immune
 * window, per-run budget — every drop incrementing its named journal
 * counter. Pure: state is passed in, mutated in place.
 *
 * @module
 */

import type { Severity } from './settings.ts'
import { quarantineHit } from './quarantine.ts'

/**
 * The verbatim omp suppressed-phrase set (omp emission-guard.ts:52-89),
 * pre-normalized. EXACT-SET semantics: substring matching is NOT the design —
 * "Stop." normalizes to `stop` and matches; a genuine blocker like
 * "Stop: 'await' missing on writeStream.end()" must NOT match.
 * 37 entries, copied verbatim.
 */
export const SUPPRESSED_NORMALIZED_PHRASES: Record<string, true> = Object.fromEntries([
  'stop', 'stop here', 'stop now', 'halt', 'abort', 'done', 'task done',
  'task complete', 'complete', 'finished', 'ok', 'okay', 'ok done',
  'no issue', 'no issues', 'no issue continue', 'no concerns', 'no concern',
  'nothing to add', 'nothing to flag', 'nothing to report', 'no notes',
  'no further input', 'no further input needed', 'no further input required',
  'no further watcher input', 'no further watcher input needed',
  'no further advice', 'no further advice needed', 'lgtm', 'looks good',
  'all good', 'agent is on track', 'agent on track', 'on track', 'continue',
  'carry on',
].map(phrase => [phrase, true as const]))

/** omp's exact normalize shape (emission-guard.ts:33-39): lowercase → NFKC → fold non-alphanumeric runs to one space → trim. Unicode-aware (\p{L}/\p{N}): an ASCII-only class would collapse every non-Latin note to one shared fingerprint and make dedupe eat distinct notes. */
export function normalizeAdvisorNote(text: string): string {
  return text.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** The dedupe LRU capacity (omp `DEFAULT_HISTORY_CAPACITY`, 309→92 rationale). */
export const DEDUPE_CAPACITY = 4096

/** The named drop counters of the journal (§4.6), verbatim field list. */
export interface DropCounters {
  denylist: number
  duplicate: number
  budget: number
  immune: number
  quarantined: number
  stale: number
  malformed: number
  severity: number
  cursorReset: number
  sessionCap: number
}

export function emptyDrops(): DropCounters {
  return { denylist: 0, duplicate: 0, budget: 0, immune: 0, quarantined: 0, stale: 0, malformed: 0, severity: 0, cursorReset: 0, sessionCap: 0 }
}

/** A note as parsed from the advisor's output. */
export interface AdvisorNote {
  severity: Severity
  text: string
}

/** The mutable per-session guard state (§4.4). */
export interface GuardState {
  /** Flat fingerprint LRU: normalized text → true, `4096` entries. */
  dedupe: Map<string, true>
  /** Delivered notes this session (the §4.4 session cap). */
  deliveredNotes: number
  /** Immune-window arm: fresh `concern` notes are dropped while `turnCounter < immuneUntil`. */
  immuneUntil: number
}

export function emptyGuardState(): GuardState {
  return { dedupe: new Map(), deliveredNotes: 0, immuneUntil: 0 }
}

/** One fingerprint insertion with flat-LRU eviction (oldest insertion order). */
export function rememberFingerprint(state: GuardState, fingerprint: string): void {
  if (state.dedupe.has(fingerprint)) state.dedupe.delete(fingerprint)
  state.dedupe.set(fingerprint, true)
  while (state.dedupe.size > DEDUPE_CAPACITY) {
    const oldest = state.dedupe.keys().next().value
    if (oldest === undefined) break
    state.dedupe.delete(oldest)
  }
}

/**
 * Apply the emission guard in its FIXED order (§4.4 steps 1-6; step 7
 * staleness is resolve-time in wiring.ts), mutating `drops` per drop and
 * returning the surviving notes in order.
 * @param turnCounter - the RESOLVE-time turn counter (immune arithmetic).
 * @param delivered - true when this run will actually deliver (guards the
 *   immune re-arm decision made by the caller, §4.4 step 5).
 */
export function applyEmissionGuard(
  state: GuardState,
  notes: readonly AdvisorNote[],
  drops: DropCounters,
  settings: { severities: readonly Severity[]; budget: number },
  turnCounter: number,
): AdvisorNote[] {
  const survivors: AdvisorNote[] = []
  for (const note of notes) {
    // 1. severity filter.
    if (!settings.severities.includes(note.severity)) {
      drops.severity += 1
      continue
    }
    // 2. normalized denylist: exact membership only.
    if (SUPPRESSED_NORMALIZED_PHRASES[normalizeAdvisorNote(note.text)] === true) {
      drops.denylist += 1
      continue
    }
    // 3. quarantine (§4.5).
    if (quarantineHit(note.text) !== undefined) {
      drops.quarantined += 1
      continue
    }
    // 4. flat dedupe (deliberate deviation from omp: shown at most once
    // regardless of severity — errs toward silence, §4.4).
    const fingerprint = normalizeAdvisorNote(note.text)
    if (state.dedupe.has(fingerprint)) {
      drops.duplicate += 1
      continue
    }
    // 5. immune window: only fresh `concern` notes are suppressed; `nit` and
    // `blocker` are unaffected.
    if (note.severity === 'concern' && turnCounter < state.immuneUntil) {
      drops.immune += 1
      continue
    }
    survivors.push(note)
  }
  // 6. per-run budget: blockers exempt; excess non-blockers drop.
  let nonBlockers = 0
  const budgeted: AdvisorNote[] = []
  for (const note of survivors) {
    if (note.severity === 'blocker') {
      budgeted.push(note)
      continue
    }
    if (nonBlockers >= settings.budget) {
      drops.budget += 1
      continue
    }
    nonBlockers += 1
    budgeted.push(note)
  }
  // Fingerprints are remembered for DELIVERED notes only (the caller moves
  // them into the LRU on delivery success — see wiring.ts).
  return budgeted
}
