/**
 * The claim table (plan docs/plans/2026-10-09-runtime-verified-completion.md
 * §3.3): data in `claims.json`, compiled here into case-insensitive matchers.
 * Rows without a `head` field are skipped at load (a phrase-only row would
 * flag every receipt-less turn). Head matching runs per command segment — the
 * scrubbed head splits once on `&&`, `||`, `;`, `|` (two-char forms precede
 * the bare `|` in the alternation); a segment satisfies a row when it matches
 * the row's head regex AND not its headDeny. Matching reads the stored
 * scrubbed `head` of in-session `completion-gate/receipt` events only.
 *
 * @module @dsh-cc/completion-gate/claims
 */

import rawTable from './claims.json' with { type: 'json' }

/** One raw row of `claims.json` (RegExp source strings). */
interface ClaimRow {
  id: string
  phrase: string
  tool: string
  head?: string
  headDeny?: string
}

/** One compiled claim row; all regexes are case-insensitive (§3.3). */
export interface CompiledClaim {
  id: string
  phrase: RegExp
  tool: string
  head: RegExp
  headDeny?: RegExp
}

/** Segment separator: single alternation pass, two-char forms before bare `|`. */
const SEGMENT_SPLIT = /&&|\|\||;|\|/

/**
 * Split a stored head into command segments. Quoting is NOT parsed — accepted
 * corners of §3.3 (quoted literals can splinter and match; single-verb
 * wrappers with no separator never match an anchored row).
 */
export function segmentHead(head: string): string[] {
  return head.split(SEGMENT_SPLIT)
}

/**
 * Compile the claim table: rows without `head` are dropped, everything
 * compiles case-insensitive (one flag for the whole table).
 */
export function loadClaims(): CompiledClaim[] {
  const rows = rawTable as readonly ClaimRow[]
  const claims: CompiledClaim[] = []
  for (const row of rows) {
    if (typeof row.head !== 'string') continue
    const claim: CompiledClaim = {
      id: row.id,
      phrase: new RegExp(row.phrase, 'i'),
      tool: row.tool,
      head: new RegExp(row.head, 'i'),
    }
    if (typeof row.headDeny === 'string') claim.headDeny = new RegExp(row.headDeny, 'i')
    claims.push(claim)
  }
  return claims
}

/**
 * Claims whose PHRASE matches the assistant text (the claim-detection half).
 */
export function matchPhrases(claims: readonly CompiledClaim[], text: string): CompiledClaim[] {
  return claims.filter(claim => claim.phrase.test(text))
}

/**
 * Whether ONE receipt (canonical tool id + stored scrubbed head) satisfies a
 * claim row: tool equality plus per-segment head/headDeny evaluation. A
 * head-less receipt (captured while disabled) never satisfies — fail-open
 * (§5.4).
 */
export function receiptSatisfies(
  claim: CompiledClaim,
  receipt: { tool: string; head?: string },
): boolean {
  if (receipt.tool !== claim.tool) return false
  if (typeof receipt.head !== 'string') return false
  return segmentHead(receipt.head).some(
    segment => claim.head.test(segment) && !(claim.headDeny?.test(segment) ?? false),
  )
}
