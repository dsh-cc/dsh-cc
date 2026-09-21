/**
 * Metric folding: raw session-log events → `MetricVector` (plan §3.3). Pure
 * functions; file I/O and counters merging live in other slices. Tokens fold
 * only over `assistant/message` events carrying a usage record — usage-less
 * assistant messages are LEGAL (interrupted turns) and are surfaced by
 * `usageCoverage`, never counted or errored.
 *
 * Loud failure (plan §7): any usage-bearing event (its data has `usage`, or
 * carries top-level `inputTokens`/`outputTokens`) whose shape deviates throws
 * `MetricDeviationError` — and so does a `request/header` lacking
 * `header.config.provider`/`model`, because foldCost would silently mis-bucket
 * every subsequent usage record.
 *
 * `tokens.total` is computed as input+output+cacheRead+cacheWrite, NOT
 * `usage.totalTokens`: the upstream field's semantics differ (it may exclude
 * cache traffic), so the vector needs a self-consistent definition.
 *
 * @module @dsh-cc/token-efficiency/metrics
 */
import type { SessionLogEvent } from '@dsh-cc/cache-trajectory'
import { foldCost, type ModelPrice } from '@dsh-cc/command-cost'

/** Thrown when a usage-relevant event deviates from the fold contract. */
export class MetricDeviationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetricDeviationError'
  }
}

/**
 * The shared metric vector consumed by the frozen gate (plan §3.3). `capability`
 * is never set here — the mock runner adds it in a later slice, so replay
 * vectors keep it absent (§3.2/§5 lazy-load honesty). `counters` starts empty;
 * the caller merges ccr.* etc. counters in.
 */
export interface MetricVector {
  task: string
  capability?: { ok: boolean }
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  costUsd?: number
  counters: Record<string, number>
}

interface LooseUsage {
  inputTokens?: unknown
  outputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
}

function isTokenUsage(value: unknown): value is {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
} {
  return typeof value === 'object' && value !== null
    && typeof (value as LooseUsage).inputTokens === 'number'
    && typeof (value as LooseUsage).outputTokens === 'number'
}

/** Whether an event carries usage-like data at all, per the deviation rule. */
function isUsageBearing(event: SessionLogEvent): boolean {
  const data = event.data
  if (typeof data !== 'object' || data === null) return false
  if ('usage' in data) return true
  return 'inputTokens' in data || 'outputTokens' in data
}

/**
 * Validate every event and shape the log for `foldCost`. Only usage-bearing
 * events and `request/header` events are subject to the deviation rules;
 * unknown event types pass through untouched (foldCost ignores them).
 * The return is cast to the typed harness `SessionEvent` union because that
 * type belongs to `@deepseek-ai/dsh-session` (a harness-only link dep we must
 * not add as a runtime dependency); after validation above the structural
 * shape is guaranteed to satisfy foldCost's reads.
 */
export function adaptForFoldCost(events: readonly SessionLogEvent[]): readonly SessionEventLike[] {
  return events.map((event, index) => {
    if (event.type === 'request/header') {
      const config = (event.data as { header?: { config?: Record<string, unknown> } } | undefined)?.header?.config
      if (typeof config?.provider !== 'string' || typeof config?.model !== 'string') {
        throw new MetricDeviationError(
          `request/header at index ${index} lacks header.config.provider/model; foldCost would mis-bucket usage`,
        )
      }
      return event as SessionEventLike
    }
    if (event.type === 'assistant/message') {
      const usage = (event.data as { usage?: unknown } | undefined)?.usage
      if (usage !== undefined && !isTokenUsage(usage)) {
        throw new MetricDeviationError(
          `assistant/message at index ${index} has a deviant usage record (expected numeric inputTokens/outputTokens)`,
        )
      }
      return event as SessionEventLike
    }
    if (isUsageBearing(event)) {
      throw new MetricDeviationError(
        `event of type ${event.type} at index ${index} is usage-bearing but not assistant/message with a well-formed TokenUsage`,
      )
    }
    return event as SessionEventLike
  })
}

/**
 * Structural stand-in for the harness `SessionEvent` union (from
 * `@deepseek-ai/dsh-session`), kept local to avoid a harness runtime dep.
 */
export type SessionEventLike = {
  type: string
  data?: Record<string, unknown>
  time?: number
}

/**
 * Fold raw session-log events into the shared `MetricVector` (plan §3.3).
 * When `priceTable` is provided, cost is folded via `@dsh-cc/command-cost`'s
 * `foldCost` over the validated adapter output and summed across all model
 * buckets; otherwise `costUsd` is absent.
 */
export function foldMetricVector(
  events: readonly SessionLogEvent[],
  opts: { task: string; priceTable?: readonly ModelPrice[] },
): MetricVector {
  const adapted = adaptForFoldCost(events)
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const event of adapted) {
    if (event.type !== 'assistant/message') continue
    const usage = (event.data as { usage?: LooseUsage } | undefined)?.usage
    if (usage === undefined || !isTokenUsage(usage)) continue
    tokens.input += usage.inputTokens
    tokens.output += usage.outputTokens
    tokens.cacheRead += usage.cacheReadTokens ?? 0
    tokens.cacheWrite += usage.cacheWriteTokens ?? 0
  }
  const vector: MetricVector = {
    task: opts.task,
    tokens: { ...tokens, total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite },
    counters: {},
  }
  if (opts.priceTable !== undefined) {
    // Structural cast: the harness SessionEvent union's shape is guaranteed by
    // adaptForFoldCost's validation, without importing @deepseek-ai/dsh-session.
    vector.costUsd = foldCost(adapted as Parameters<typeof foldCost>[0], opts.priceTable)
      .perModel.reduce((sum, m) => sum + m.costUsd, 0)
  }
  return vector
}

/** Coverage for report footers: how many assistant messages carried usage. */
export function usageCoverage(events: readonly SessionLogEvent[]): { assistantMessages: number; withUsage: number } {
  let assistantMessages = 0
  let withUsage = 0
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    assistantMessages += 1
    const usage = (event.data as { usage?: unknown } | undefined)?.usage
    if (isTokenUsage(usage)) withUsage += 1
  }
  return { assistantMessages, withUsage }
}
