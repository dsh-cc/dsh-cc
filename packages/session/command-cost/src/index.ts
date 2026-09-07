/**
 * Human-facing `/cost` command over the session usage log. Folds each
 * `assistant/message` usage record against the latest `request/header` model
 * route and the deployment price table from Config.
 * @module @dsh-cc/command-cost
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { foldCost, formatCostReport, type ModelPrice } from './cost.ts'
import { helpable } from '@dsh-cc/command-usage'

export const name = 'command-cost'
export const inject = ['commands']

/** `/cost` configuration: the deployment USD price table. */
export interface Config {
  /** Ordered price-table columns; the first exact model match wins, then a `'*'` column. */
  readonly modelTable: readonly ModelPrice[]
}

/** Loader schema for the price table with no cost defaults (an empty table prices nothing). */
export const Config = z.object({
  modelTable: z.array(z.object({
    model: z.string().required(),
    provider: z.string(),
    inputPerMTok: z.number().required(),
    outputPerMTok: z.number().required(),
    cacheReadPerMTok: z.number().required(),
    cacheWritePerMTok: z.number().required(),
  })).required(),
})

/** Execute `/cost` against the invocation's own session log. */
function executeCost(config: Config, invocation: CommandInvocation): CommandResult {
  const events = invocation.agent.session.events
  const report = foldCost(events, config.modelTable)
  return { kind: 'success', text: formatCostReport(report) }
}

/**
 * Register the Codex-shaped `/cost` command for every composed command adapter.
 * @param ctx - context carrying the command registry.
 * @param config - deployment price table.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.commands.register(helpable({
    name: 'cost',
    description: 'show per-model token usage and estimated cost for this session',
    handler: invocation => executeCost(config, invocation),
  }))
}
