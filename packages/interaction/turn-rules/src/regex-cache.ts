/**
 * Compiled-regex LRU (plan docs/plans/2026-09-23-turn-rules.md §4.2): compile
 * on miss, evict least-recently-used past the capacity. Compile errors are
 * impossible post-validation (§4.1) but still fail soft (`undefined`), never a
 * throw into a listener.
 *
 * @module
 */

/** Compile-and-cache lookup: regex source → compiled pattern (or `undefined` on the impossible compile error). */
export type RegexCache = (source: string) => RegExp | undefined

/** Create a bounded LRU regex cache with the given capacity. */
export function createRegexCache(capacity: number): RegexCache {
  const cache = new Map<string, RegExp>()
  return (source: string): RegExp | undefined => {
    const hit = cache.get(source)
    if (hit !== undefined) {
      // Refresh recency (Map iteration order is insertion order).
      cache.delete(source)
      cache.set(source, hit)
      return hit
    }
    let compiled: RegExp
    try {
      compiled = new RegExp(source)
    } catch {
      return undefined
    }
    if (capacity > 0 && cache.size >= capacity) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(source, compiled)
    return compiled
  }
}
