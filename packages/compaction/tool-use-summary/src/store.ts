/**
 * The per-session in-memory LRU store of TUS rows (dedupe + cap fast path).
 * @module @dsh-cc/tool-use-summary/store
 */

import type { SummaryRow } from './types.ts'

export class SummaryStore {
  /** Per session: insertion+usage-ordered map (Map iteration order = LRU order). */
  private readonly sessions = new Map<string, Map<string, SummaryRow>>()

  constructor(private readonly maxPerSession: () => number) {}

  private sessionMap(sessionId: string): Map<string, SummaryRow> {
    let map = this.sessions.get(sessionId)
    if (map === undefined) {
      map = new Map()
      this.sessions.set(sessionId, map)
    }
    return map
  }

  has(sessionId: string, callId: string): boolean {
    return this.sessions.get(sessionId)?.has(callId) ?? false
  }

  /**
   * Insert a row; when the session is at capacity the least-recently-used
   * entry is evicted first (the ledger keeps every row regardless).
   */
  put(sessionId: string, row: SummaryRow): void {
    const map = this.sessionMap(sessionId)
    map.delete(row.callId)
    map.set(row.callId, row)
    while (map.size > this.maxPerSession()) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  size(sessionId: string): number {
    return this.sessions.get(sessionId)?.size ?? 0
  }

  /** Evict least-recently-used entries until the session is under `cap`. */
  evictLru(sessionId: string, cap: number): void {
    const map = this.sessions.get(sessionId)
    if (map === undefined) return
    while (map.size >= cap && cap > 0) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }
}
