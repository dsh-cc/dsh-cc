/**
 * Human-facing `/cost` command over the session usage log. Folds each
 * `assistant/message` usage record against the latest `request/header` model
 * route and the deployment price table from Config.
 * @module @dsh-cc/command-cost
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { foldCost, formatCostReport, type CostReport, type ModelPrice } from './cost.ts'
import { readDecisionCostSection } from './decisions.ts'
import { helpable } from '@dsh-cc/command-usage'
import { dshHomeFn, projectKeyOf } from '@dsh-cc/sidecar-io'

/** Pricing primitives shared with other packages (e.g. compaction-cost-gate). */
export { resolvePrice, foldCost } from './cost.ts'
export type { ModelPrice } from './cost.ts'
/** SystemOne decision accounting merged into the report. */
export { dedupeDecisionRows, foldDecisionUsage, readDecisionCostSection } from './decisions.ts'
export type { DecisionCostRow, DecisionUsageEvidence } from './decisions.ts'
export type {
  CostDecisionModelTotal,
  CostDecisionSection,
  CostModelTotal,
  CostReport,
} from './cost.ts'

export const name = 'command-cost'
export const inject = ['commands']

/** `/cost` configuration: the deployment USD price table. */
export interface Config {
  /** Ordered price-table columns; matched by exact model id first (first row wins), then by `/`-suffix for route-prefixed runtime ids (longest row wins, ties → first row), then a `'*'` column. */
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

/** The decisions-ledger scope of this invocation's session (mirrors the writer's derivation). */
interface DecisionScope {
  readonly projectKey: string
  readonly sessionId: string
}

/**
 * Derive the ledger scope exactly as the writing service does: projectKey from
 * `projectKeyOf(path.resolve(session.header.cwd))`, sessionId from the live
 * `agent.session.id` (the ledger path encoder neutralizes the raw id). Missing
 * or unusable host facts yield undefined — /cost never guesses `process.cwd()`,
 * it just renders no decisions section.
 */
function decisionScopeOf(invocation: CommandInvocation): DecisionScope | undefined {
  try {
    const session = invocation.agent.session
    const cwd = session.header.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return undefined
    const sessionId = String(session.id)
    if (sessionId.length === 0) return undefined
    return { projectKey: projectKeyOf(resolve(cwd)), sessionId }
  } catch {
    return undefined
  }
}

/**
 * Execute `/cost` against the invocation's own session log, then merge the
 * session's SystemOne decision ledger when one exists. The decision read is
 * read-only and degrades to "no section"; the generative section always renders.
 */
async function executeCost(
  ctx: Context,
  config: Config,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const events = invocation.agent.session.snapshotEvents()
  const report = foldCost(events, config.modelTable)
  // Read the harness-home resolver per invocation: a host that publishes it
  // after mounting this plugin still gets the decisions section.
  const decisions = await readDecisionCostSection(dshHomeFn(ctx), decisionScopeOf(invocation), config.modelTable)
  const merged: CostReport = decisions === undefined ? report : { ...report, decisions }
  return { kind: 'success', text: formatCostReport(merged) }
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
    handler: invocation => executeCost(ctx, config, invocation),
  }))
}
