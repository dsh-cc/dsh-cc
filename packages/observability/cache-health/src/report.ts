/**
 * Pure /cache-health fold and render: joins ledger rows with session-event
 * usage records and renders a plain-text report. No cordis or fs imports —
 * unit-testable in isolation.
 *
 * @module @dsh-cc/cache-health/report
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { LedgerRow } from './ledger.ts'

/** Usage folded onto one ledger row. */
export interface UsageFold {
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** The full /cache-health report before rendering. */
export interface CacheHealthReport {
  /** Latest row's stable-prefix state (undefined with no rows). */
  readonly current?: {
    readonly stableSegments: number
    readonly stablePrefixHash: string
    readonly stablePrefixTokensEst: number
    readonly changedSinceLastCall: boolean
  }
  /** Rows whose prefix changed, in seq order. */
  readonly driftRows: readonly LedgerRow[]
  /** Drift rows at segment index <= 2 (system/tools/first message volatility). */
  readonly frontLoadedSuspects: readonly LedgerRow[]
  /** Drift rows at later indexes — tail appends, not prefix busters. */
  readonly tailAppends: readonly LedgerRow[]
  /** Per-row usage ratio plus session totals. */
  readonly usage: {
    readonly perRow: readonly (readonly [LedgerRow, UsageFold])[]
    readonly totalCacheReadTokens: number
    readonly totalCacheWriteTokens: number
  }
}

/** Disclaimer for provider-metered cache counters (zero ≠ miss). */
export const CACHE_METER_DISCLAIMER
  = 'provider-metered; zero-metered upstreams (e.g. glm-5.2 via llmbox) produce zeros, not evidence of misses'

/** Disclaimer for tail-appends (they extend, not bust, the prefix). */
export const TAIL_APPEND_NOTE
  = 'tail appends extend the prefix rather than busting it'

function isTokenUsage(value: unknown): value is TokenUsage {
  return typeof value === 'object' && value !== null
    && typeof (value as TokenUsage).inputTokens === 'number'
    && typeof (value as TokenUsage).outputTokens === 'number'
}

/**
 * Fold session-event usage onto ledger rows by the interval rule: with rows
 * sorted by seq, a usage event at seq s accrues to row i when
 * `rows[i].seq < s <= rows[i+1].seq` (the last row takes all remaining
 * usage); events at or before the first row's seq are dropped. Rows sharing
 * a seq (same throughSeq) therefore split the boundary: only the LAST row
 * with that seq can receive events strictly after it.
 * @param rows - ledger rows in append order (any order is tolerated).
 * @param events - the session's durable event log, in sequence order.
 */
export function foldUsage(
  rows: readonly LedgerRow[],
  events: readonly SessionEvent[],
): readonly (readonly [LedgerRow, UsageFold])[] {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq)
  const folds = sorted.map(() => ({ cacheReadTokens: 0, cacheWriteTokens: 0 }))
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const usage = event.data.usage
    if (usage === undefined || !isTokenUsage(usage)) continue
    // Usage belongs to the row that CLOSED the interval
    // (rows[i].seq < s <= rows[i+1].seq): the last row with seq < s, or none
    // when s <= rows[0].seq.
    let target = -1
    for (let i = 0; i < sorted.length; i++) {
      const row = sorted[i]
      if (row !== undefined && row.seq < event.seq) target = i
      else break
    }
    if (target === -1) continue
    const fold = folds[target]
    if (fold === undefined) continue // unreachable: target < sorted.length
    fold.cacheReadTokens += usage.cacheReadTokens ?? 0
    fold.cacheWriteTokens += usage.cacheWriteTokens ?? 0
  }
  return sorted.map((row, i) => [row, folds[i] as UsageFold] as const)
}

/**
 * Build the report: join rows with usage, split drift rows into
 * front-loaded suspects (driftSegmentIndex <= 2: system/tools/first message
 * carry cwd and DSH_SESSION_* volatility) and tail appends.
 */
export function buildReport(
  rows: readonly LedgerRow[],
  events: readonly SessionEvent[],
): CacheHealthReport {
  const perRow = foldUsage(rows, events)
  const driftRows = [...rows].sort((a, b) => a.seq - b.seq).filter(row => row.prefixChanged)
  const last = [...rows].sort((a, b) => a.seq - b.seq).at(-1)
  let totalRead = 0
  let totalWrite = 0
  for (const [, fold] of perRow) {
    totalRead += fold.cacheReadTokens
    totalWrite += fold.cacheWriteTokens
  }
  return {
    ...(last !== undefined
      ? {
          current: {
            stableSegments: last.stableSegments,
            stablePrefixHash: last.stablePrefixHash,
            stablePrefixTokensEst: last.stablePrefixTokensEst,
            changedSinceLastCall: last.prefixChanged,
          },
        }
      : {}),
    driftRows,
    frontLoadedSuspects: driftRows.filter(row => (row.driftSegmentIndex ?? Number.MAX_SAFE_INTEGER) <= 2),
    tailAppends: driftRows.filter(row => (row.driftSegmentIndex ?? Number.MAX_SAFE_INTEGER) > 2),
    usage: { perRow, totalCacheReadTokens: totalRead, totalCacheWriteTokens: totalWrite },
  }
}

/** Ratio display: read share of metered cache traffic (read / (read + write)). */
function readShare(fold: UsageFold): string {
  const total = fold.cacheReadTokens + fold.cacheWriteTokens
  if (total === 0) return 'n/a'
  return `${Math.round((fold.cacheReadTokens / total) * 100)}%`
}

/**
 * Render the report as human shell text in the /cost style.
 * @param report - the fold result.
 * @returns the multi-line report text.
 */
export function renderReport(report: CacheHealthReport): string {
  const lines: string[] = []
  if (report.current === undefined) {
    return 'No cache-health data yet; no model call has been observed for this session.'
  }
  lines.push('Prompt-cache health', '')
  lines.push(
    `Current stable prefix: ${report.current.stableSegments} segments,`
    + ` ~${report.current.stablePrefixTokensEst} tokens (estimate),`
    + ` hash ${report.current.stablePrefixHash.slice(0, 16)},`
    + ` changed since last call: ${report.current.changedSinceLastCall ? 'yes' : 'no'}`,
  )
  lines.push('')
  if (report.driftRows.length === 0) {
    lines.push('No prefix drift observed.')
  } else {
    lines.push('Prefix drift (changed segments):')
    for (const row of report.driftRows) {
      lines.push(
        `  seq ${row.seq} ${row.provider}/${row.model}`
        + ` segment ${row.driftSegmentIndex ?? '?'}: ${row.driftExcerpt ?? '(n/a)'}`,
      )
    }
  }
  lines.push('')
  if (report.frontLoadedSuspects.length > 0) {
    lines.push('Front-loaded suspects (drift at segment <= 2: system/tools/first message):')
    for (const row of report.frontLoadedSuspects) {
      lines.push(`  seq ${row.seq} ${row.provider}/${row.model} segment ${row.driftSegmentIndex ?? '?'}`)
    }
  } else {
    lines.push('No front-loaded suspects.')
  }
  lines.push(`Not suspects: ${report.tailAppends.length} drift row(s) at later indexes — ${TAIL_APPEND_NOTE}.`)
  lines.push('')
  lines.push('Provider-metered cache usage per call:')
  for (const [row, fold] of report.usage.perRow) {
    lines.push(
      `  seq ${row.seq} ${row.provider}/${row.model}:`
      + ` read ${fold.cacheReadTokens}, write ${fold.cacheWriteTokens} (read share ${readShare(fold)})`,
    )
  }
  lines.push(
    `Session totals: read ${report.usage.totalCacheReadTokens},`
    + ` write ${report.usage.totalCacheWriteTokens}`,
  )
  lines.push(`Note: ${CACHE_METER_DISCLAIMER}.`)
  return lines.join('\n')
}
