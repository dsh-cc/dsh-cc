/**
 * The lexical baseline of ToolSearch: token overlap between a free-text query
 * and a deferred tool's name, search hint and description.
 *
 * Extracted verbatim from `index.ts` when S1-05 added the discovery wiring. It
 * stays the untouched original ranking (`mode: off` and every discovery
 * fallback execute it byte-for-byte), and the discovery layer reads the same
 * score as an untrusted tie-break input only — never as a filter — so keeping
 * the two in one small pure module makes that boundary explicit.
 *
 * @module @dsh-cc/tool-search/search-scoring
 */

/** The searchable metadata of one deferred registration. */
export interface ScorableDeferred {
  readonly reg: {
    readonly name: string
    readonly description: string
    readonly searchHint?: string | undefined
  }
}

/** Lowercase the input and split into alphanumeric tokens, dropping empty ones. */
function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/**
 * How much a deferred tool matches a query, summed over query tokens and the
 * weighted name/description/searchHint fields. `name` carries the most weight,
 * `searchHint` next, then `description`; an exact name match is conclusive.
 * Pure and deterministic: used only to rank the candidate set.
 * @param stored - the deferred registration.
 * @param query - the raw ToolSearch query.
 * @returns a non-negative score; `0` means no match.
 */
export function scoreStored(stored: ScorableDeferred, query: string): number {
  const q = query.toLowerCase().trim()
  if (q.length === 0) return 0
  const qTokens = tokenize(q)
  const fields: Array<readonly [string, number]> = [
    [stored.reg.name.toLowerCase(), 10],
    [(stored.reg.searchHint ?? '').toLowerCase(), 4],
    [stored.reg.description.toLowerCase(), 2],
  ]
  let total = 0
  for (const [text, weight] of fields) {
    if (text.length === 0) continue
    for (const token of qTokens) {
      if (token.length === 0) continue
      if (text.includes(token)) {
        total += weight
      } else if (tokenize(text).some(word => word.startsWith(token) || token.startsWith(word))) {
        total += Math.max(1, Math.floor(weight / 2))
      }
    }
  }
  return total
}
