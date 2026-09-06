/**
 * Pure `/stats` folding: session events → turn/step counts, tool-call
 * distribution, and token usage totals, plus human-readable report. No cordis
 * imports, so the fold and formatting are unit-testable in isolation.
 * @module @dsh-cc/command-stats/stats
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** A single tool-name → call-count entry in the distribution. */
export interface ToolCallStat {
  readonly name: string
  readonly calls: number
}

/** Accumulated conversation statistics folded from the session log. */
export interface StatsReport {
  /** Completed turns (`turn/end` events). */
  readonly turns: number
  /** Closed steps (`step/end` events). */
  readonly steps: number
  /** Surface user messages (`user/message` events). */
  readonly userMessages: number
  /** Assistant messages (`assistant/message` events). */
  readonly assistantMessages: number
  /** Tool calls grouped by name, most-called first. */
  readonly toolCalls: readonly ToolCallStat[]
  /** Total tool calls across every name. */
  readonly totalToolCalls: number
  /** Summed uncached input tokens across usage records. */
  readonly inputTokens: number
  /** Summed output tokens across usage records. */
  readonly outputTokens: number
  /** Summed cache-read tokens across usage records. */
  readonly cacheReadTokens: number
  /** Summed cache-write tokens across usage records. */
  readonly cacheWriteTokens: number
}

/** Whether a runtime usage record satisfies the `TokenUsage` contract enough to fold. */
function isTokenUsage(value: unknown): value is TokenUsage {
  return typeof value === 'object' && value !== null
    && typeof (value as TokenUsage).inputTokens === 'number'
    && typeof (value as TokenUsage).outputTokens === 'number'
}

/**
 * Fold a session event log into whole-session statistics.
 * @param events - the session's durable event log, in sequence order.
 * @returns the accumulated report (all-zero when the log has no matching events).
 */
export function foldStats(events: readonly SessionEvent[]): StatsReport {
  let turns = 0
  let steps = 0
  let userMessages = 0
  let assistantMessages = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  const calls = new Map<string, number>()
  for (const event of events) {
    switch (event.type) {
      case 'turn/end':
        turns += 1
        break
      case 'step/end':
        steps += 1
        break
      case 'user/message':
        userMessages += 1
        break
      case 'assistant/message':
        assistantMessages += 1
        if (event.data.usage !== undefined && isTokenUsage(event.data.usage)) {
          inputTokens += event.data.usage.inputTokens
          outputTokens += event.data.usage.outputTokens
          cacheReadTokens += event.data.usage.cacheReadTokens ?? 0
          cacheWriteTokens += event.data.usage.cacheWriteTokens ?? 0
        }
        break
      case 'tool/call':
        calls.set(event.data.name, (calls.get(event.data.name) ?? 0) + 1)
        break
      default:
        break
    }
  }
  const toolCalls = [...calls.entries()]
    .map(([name, count]) => ({ name, calls: count }))
    .sort((a, b) => b.calls - a.calls || (a.name < b.name ? -1 : 1))
  const totalToolCalls = toolCalls.reduce((sum, stat) => sum + stat.calls, 0)
  return {
    turns,
    steps,
    userMessages,
    assistantMessages,
    toolCalls,
    totalToolCalls,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  }
}

/**
 * Render the fold result as human shell text. An empty report says so directly.
 * @param report - the fold result.
 * @returns the multi-line report text.
 */
export function formatStatsReport(report: StatsReport): string {
  if (report.turns === 0 && report.steps === 0 && report.totalToolCalls === 0 && report.inputTokens === 0) {
    return 'No session activity yet.'
  }
  const lines = [
    'Session stats',
    '',
    `Turns: ${report.turns}`,
    `Steps: ${report.steps}`,
    `User messages: ${report.userMessages}`,
    `Assistant messages: ${report.assistantMessages}`,
    `Tool calls: ${report.totalToolCalls}`,
  ]
  if (report.toolCalls.length > 0) {
    for (const stat of report.toolCalls) {
      lines.push(`  ${stat.name}: ${stat.calls}`)
    }
  }
  lines.push('', 'Token usage (input / output / cache-read / cache-write):')
  lines.push(`  ${report.inputTokens} / ${report.outputTokens} / ${report.cacheReadTokens} / ${report.cacheWriteTokens}`)
  return lines.join('\n')
}
