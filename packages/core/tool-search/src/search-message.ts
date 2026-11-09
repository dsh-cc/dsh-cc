/**
 * The model-facing copy of one ToolSearch outcome.
 *
 * Extracted verbatim from `index.ts` when S1-05 added the discovery wiring: the
 * rendering is a pure function of the activated results and the pool state, it
 * is the same on every path (`mode: off`, every lexical fallback, and an active
 * judgment), and it must stay byte-identical to the pre-S1-05 output — keeping
 * it in one small module makes that invariant reviewable and keeps `index.ts`
 * inside the repo's per-file budget.
 *
 * @module @dsh-cc/tool-search/search-message
 */

/** One activated (or refused) result as the model sees it. */
export interface SearchResultEntry {
  readonly name: string
  readonly description: string
  readonly status: string
  readonly reason?: string
}

/**
 * Compose the full model-facing ToolSearch outcome, branching on pool state so
 * an empty search never reads as "you lack the capability" — the trap this
 * copy exists to defuse is a model concluding it has no filesystem/shell tools
 * when in fact the deferred pool is simply empty (or already fully loaded).
 * @param query - the model's raw query.
 * @param results - the activated/refused entries, in activation order.
 * @param total - non-alwaysLoad deferred entries the scope can see.
 * @param searchable - of those, the ones not yet activated.
 * @returns the `message` field of the tool result.
 */
export function composeSearchMessage(
  query: string,
  results: readonly SearchResultEntry[],
  total: number,
  searchable: number,
): string {
  if (results.length > 0) return renderToolSearchText(query, results)
  if (total === 0) {
    return 'No deferred tools are available to you in this session — every tool you can use is already in your function list; call it directly.'
  }
  if (searchable === 0) {
    return 'All deferred tools available to you are already loaded; call them directly.'
  }
  return `No deferred tools matched "${query}". This directory lists deferred tools only; tools that registered eagerly (including eager MCP tools) never appear here — they are already in your function list, call them directly.`
}

/** Compose the model-facing summary of a ToolSearch outcome. */
function renderToolSearchText(query: string, results: readonly SearchResultEntry[]): string {
  if (results.length === 0) {
    return `No deferred tools matched "${query}".`
  }
  const lines = results.map((result) => {
    const statusLabel = result.status === 'loaded' ? 'now available'
      : result.status === 'already-loaded' ? 'already available'
        : result.status === 'denied' ? 'denied'
          : 'not found'
    const tail = result.status === 'denied' && result.reason !== undefined ? ` — ${result.reason}` : ''
    return `- ${result.name}: ${result.description} (${statusLabel})${tail}`
  })
  return `ToolSearch "${query}":\n${lines.join('\n')}`
}
