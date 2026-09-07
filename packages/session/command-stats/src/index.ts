/**
 * Human-facing `/stats` command over the session event log: turn and step
 * counts, tool-call distribution, and token usage totals.
 * @module @dsh-cc/command-stats
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { foldStats, formatStatsReport } from './stats.ts'
import { helpable } from '@dsh-cc/command-usage'

export const name = 'command-stats'
export const inject = ['commands']

/** Execute `/stats` against the invocation's own session log. */
function executeStats(invocation: CommandInvocation): CommandResult {
  const report = foldStats(invocation.agent.session.events)
  return { kind: 'success', text: formatStatsReport(report) }
}

/**
 * Register the `/stats` command for every composed command adapter.
 * @param ctx - context carrying the command registry.
 */
export function apply(ctx: Context): void {
  ctx.commands.register(helpable({
    name: 'stats',
    description: 'show turn, step, tool-call, and token statistics for this session',
    handler: (invocation: CommandInvocation) => executeStats(invocation),
  }))
}
