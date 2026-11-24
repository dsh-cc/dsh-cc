/**
 * The tool-discovery shadow-verdict recorder (design
 * docs/plans/2026-11-25-systemone-shadow-verdict-ledger.md §"Feature
 * payloads"): one evaluation-grain row per ToolSearch evaluation, recorded at
 * the common post-`selectNames` point so BOTH mode branches write. Extracted
 * from `discovery-runtime.ts` for the file-size budget; no behavior lives
 * here that the runtime does not drive.
 *
 * @module @dsh-cc/tool-search/discovery-verdict-record
 */

import { createHash } from 'node:crypto'
import type { DiscoveryRunner } from './discovery-contract.ts'

/**
 * Hash a discovery query for the shadow-verdict row (first 16 hex of
 * sha256) — the raw query text never crosses the recorder seam. Local twin
 * of the ledger's helper: this package does not depend on decision-usage.
 */
export const queryHash8 = (query: string): string =>
  createHash('sha256').update(query, 'utf8').digest('hex').slice(0, 16)

/** The facts one waiter's verdict row needs, all already in the caller's scope. */
export interface DiscoveryVerdictFacts {
  readonly query: string
  readonly suggested: readonly string[]
  readonly lexical: readonly string[]
  readonly candidatesJudged: number
  readonly originSeq: number
  readonly mode: 'shadow' | 'active'
}

/**
 * Fire-and-forget: builds the closed-schema payload (set math included) and
 * voids the runner's recorder. The raw query is hashed HERE, inside this
 * layer; nothing else crosses the seam.
 */
export function recordDiscoveryVerdict(
  runner: DiscoveryRunner,
  decisionIds: readonly string[],
  facts: DiscoveryVerdictFacts,
): void {
  if (runner.recordShadowVerdict === undefined) return
  const suggestedSet = new Set(facts.suggested)
  const lexicalSet = new Set(facts.lexical)
  let suggestedOnly = 0
  for (const name of suggestedSet) if (!lexicalSet.has(name)) suggestedOnly += 1
  let lexicalOnly = 0
  for (const name of lexicalSet) if (!suggestedSet.has(name)) lexicalOnly += 1
  void runner.recordShadowVerdict({
    feature: 'tool-discovery',
    decisionIds,
    mode: facts.mode,
    payload: {
      queryHash8: queryHash8(facts.query),
      suggested: [...facts.suggested],
      lexical: [...facts.lexical],
      differing: suggestedOnly > 0 || lexicalOnly > 0,
      suggestedOnly,
      lexicalOnly,
      candidatesJudged: facts.candidatesJudged,
      originSeq: facts.originSeq,
    },
  })
}

/**
 * In-memory shadow counters (§ "Release gates and rollback": shadow accumulates
 * hit-set differences and counts — never queries, candidate names or answers).
 */
export interface DiscoveryShadowCounters {
  /** Complete judgments tallied. */
  readonly judgments: number
  /** Judgments whose suggested set differed from the lexical hit set. */
  readonly differing: number
  /** Names suggested but not among the lexical hits. */
  readonly suggestedOnly: number
  /** Lexical hits the judgment did not suggest. */
  readonly lexicalOnly: number
}

/** Mutable twin of the counter snapshot (module-private state lives here). */
type MutableCounters = { -readonly [K in keyof DiscoveryShadowCounters]: number }

/** Shadow: count the suggested-vs-lexical difference; persist nothing. */
export function shadowTally(
  counters: MutableCounters,
  suggested: readonly string[],
  lexical: readonly string[],
): void {
  counters.judgments += 1
  const suggestedSet = new Set(suggested)
  const lexicalSet = new Set(lexical)
  const suggestedOnly = suggested.filter(name => !lexicalSet.has(name)).length
  const lexicalOnly = lexical.filter(name => !suggestedSet.has(name)).length
  if (suggestedOnly + lexicalOnly > 0) counters.differing += 1
  counters.suggestedOnly += suggestedOnly
  counters.lexicalOnly += lexicalOnly
}
