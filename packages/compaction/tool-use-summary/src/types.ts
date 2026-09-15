/**
 * One durable Tool Use Summary row. Written to the append-only per-session
 * ledger and mirrored in the in-memory LRU store; also read back by
 * consumers via {@link loadSummaries}.
 */
export interface SummaryRow {
  /** Tool call the digest describes (`exec.callId`). */
  callId: string
  /** Tool name (`exec.name`). */
  tool: string
  /** UTF-8 byte size of the summarized tool result. */
  resultBytes: number
  status: 'ok' | 'failed' | 'skipped'
  skipReason?: 'disabled' | 'not-top-level' | 'small' | 'excluded' | 'cap' | 'duplicate'
  /** Digest text; status 'ok' only, bounded to ~800 chars. */
  summary?: string
  /** True when the side query ran on the inherited parent route (zero savings). */
  inheritedRoute?: boolean
  durationMs: number
  /** ISO timestamp of the row. */
  at: string
}
