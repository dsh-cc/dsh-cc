/**
 * Pure `/cost` folding: session usage → per-model totals, cost against a
 * deployment price table, and human-readable report. No cordis imports, so the
 * fold, pricing, and formatting are unit-testable in isolation from plugin
 * mounting.
 * @module @dsh-cc/command-cost/cost
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * One model column of the deployment price table. Prices are per one million
 * tokens (MTok) in USD. A column whose `model` is `'*'` is the wildcard default
 * applied to any model without a matching exact or suffix column.
 */
export interface ModelPrice {
  /** Provider model id matched against the request header's `config.model` (exact first, then `/`-suffix matching for route-prefixed runtime ids); `'*'` is the default column. */
  readonly model: string
  /** Provider route the model belongs to; must match the request header or be omitted. */
  readonly provider?: string
  /** USD per MTok billed for uncached input tokens. */
  readonly inputPerMTok: number
  /** USD per MTok billed for output tokens. */
  readonly outputPerMTok: number
  /** USD per MTok billed for cache-read input tokens; 0 when the provider does not bill it. */
  readonly cacheReadPerMTok: number
  /** USD per MTok billed for cache-write input tokens; 0 when the provider does not bill it. */
  readonly cacheWritePerMTok: number
}

/** `/cost` configuration — the price table lives entirely in the deployment Config. */
export interface CommandCostConfig {
  /** Ordered price-table columns; matched by exact id first (first row wins), then by `/`-suffix for route-prefixed runtime ids (longest row wins, ties → first row), then a `'*'` column. */
  readonly modelTable: readonly ModelPrice[]
}

/** Accumulated token counts and cost for one resolved model route. */
export interface CostModelTotal {
  /** Provider route from the request header owning the usage. */
  readonly provider: string
  /** Provider model id from the request header owning the usage. */
  readonly model: string
  /** Steps whose `assistant/message` carried a usage record. */
  readonly messages: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** Computed USD cost; 0 when no price column resolves for the model. */
  readonly costUsd: number
  /** Whether a price column resolved, so an unpriced model reads as unliquidatable. */
  readonly priced: boolean
}

/** Accumulated confirmed and reserved usage for one SystemOne decision model. */
export interface CostDecisionModelTotal {
  /** Provider route the ledger rows carry for the attempt. */
  readonly provider: string
  /** Pricing model id: `actualModel` once an attempt answered, else its `requestedModel`. */
  readonly model: string
  /** Attempt leases charged to this model; a durably refunded attempt does not count. */
  readonly attempts: number
  /** Input tokens of leases that settled `actual` — the only confirmed usage. */
  readonly inputTokens: number
  /** Output tokens of leases that settled `actual` — the only confirmed usage. */
  readonly outputTokens: number
  /** Reserved input tokens of `unknown`/unsettled leases: an upper bound, never confirmed. */
  readonly reservedInputTokens: number
  /** Reserved output tokens of `unknown`/unsettled leases: an upper bound, never confirmed. */
  readonly reservedOutputTokens: number
  /** Computed USD cost of the confirmed tokens; 0 when no price column resolves. */
  readonly costUsd: number
  /** Whether a price column resolved, so an unpriced model reads as unliquidatable. */
  readonly priced: boolean
}

/**
 * The `SystemOne decisions` section (design §"Ledger, privacy and reporting"):
 * confirmed usage priced per model, unconfirmed reservations kept separate as an
 * upper bound, and the ledger's completeness markers.
 */
export interface CostDecisionSection {
  readonly perModel: readonly CostDecisionModelTotal[]
  /** Summed USD across priced models' CONFIRMED tokens only. */
  readonly confirmedUsd: number
  /** Some lease kept its reservation as an upper bound (`unknown`/still unsettled). */
  readonly hasUnconfirmed: boolean
  /** Some model has no configured price column, so its usage joins no subtotal. */
  readonly hasUnpriced: boolean
  /** The ledger is torn or corrupt, or the session quota is durably frozen. */
  readonly incomplete: boolean
  /** Human-readable reasons for `incomplete`. */
  readonly incompleteReasons: readonly string[]
  /** Attempt leases the ledger counts (deduplicated by `eventId`). */
  readonly attemptsUsed: number
  /** Retained input tokens across every lease (confirmed actuals plus reservations). */
  readonly retainedInputTokens: number
  /** Retained output tokens across every lease (confirmed actuals plus reservations). */
  readonly retainedOutputTokens: number
}

/** The `/cost` fold result: per-model buckets plus the grand total. */
export interface CostReport {
  readonly perModel: readonly CostModelTotal[]
  /** Summed USD across every priced bucket. */
  readonly totalUsd: number
  /** SystemOne decision accounting; absent when the session recorded no decisions. */
  readonly decisions?: CostDecisionSection
}

interface CostBucket {
  provider: string
  model: string
  messages: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Round a dollar amount to whole cents for display. */
function cents(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Format one USD amount with two fixed decimal places.
 * @param value - the dollar amount to format.
 * @returns the `$`-prefixed, cents-rounded display string.
 */
export function formatUsd(value: number): string {
  return `$${cents(value).toFixed(2)}`
}

/** Whether a runtime usage record satisfies the `TokenUsage` contract enough to fold. */
function isTokenUsage(value: unknown): value is TokenUsage {
  return typeof value === 'object' && value !== null
    && typeof (value as TokenUsage).inputTokens === 'number'
    && typeof (value as TokenUsage).outputTokens === 'number'
}

/**
 * Resolve the price column for one model against the deployment table, in three
 * tiers: (1) exact — first row where `model` matches and `provider` (when set
 * on the row) matches; (2) suffix — among rows whose `model` is a
 * `/`-separated tail segment of the runtime id (runtime ids may carry a
 * deployment route prefix, e.g. `llmbox_ant/glm-5.3` naming the same model as a
 * bare `glm-5.3` row), the longest row wins, ties go to the first row in table
 * order; `'*'` rows are excluded from this tier; (3) wildcard — the first row
 * with `model === '*'`.
 * @param table - ordered deployment price table, possibly with a `'*'` entry.
 * @param provider - route from the request header.
 * @param model - model id from the request header.
 * @returns the matched column rules, or undefined when no tier matches.
 */
export function resolvePrice(
  table: readonly ModelPrice[],
  provider: string,
  model: string,
): ModelPrice | undefined {
  const matches = (price: ModelPrice) => price.provider === undefined || price.provider === provider
  const exact = table.find(price => price.model === model && matches(price))
  if (exact !== undefined) return exact
  let best: ModelPrice | undefined
  for (const price of table) {
    if (price.model === '*' || !matches(price)) continue
    if (!model.endsWith(`/${price.model}`)) continue
    if (best === undefined || price.model.length > best.model.length) best = price
  }
  return best ?? table.find(price => price.model === '*')
}

/**
 * Sum the billed input cost for one usage against one price column. Billed
 * input is the sum of uncached, cache-read, and cache-write input tokens, each
 * at its own rate.
 * @param usage - the step's usage record.
 * @param price - resolved price column.
 * @returns USD cost for the call.
 */
export function callCost(usage: TokenUsage, price: ModelPrice): number {
  const input = usage.inputTokens
  const output = usage.outputTokens
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  return (input * price.inputPerMTok + output * price.outputPerMTok
    + cacheRead * price.cacheReadPerMTok + cacheWrite * price.cacheWritePerMTok) / 1_000_000
}

/**
 * Fold session events into per-model usage and cost totals. The current model
 * route is tracked from `request/header` snapshots; each `assistant/message`
 * carrying a usage record accrues to that route. Usage is always reported;
 * cost is computed only when a price column resolves for the model.
 * @param events - the session's durable event log, in sequence order.
 * @param table - deployment price table from Config.
 * @returns the per-model buckets and grand total (empty when no usage is logged).
 */
export function foldCost(
  events: readonly SessionEvent[],
  table: readonly ModelPrice[],
): CostReport {
  const buckets = new Map<string, CostBucket>()
  const order: string[] = []
  let currentProvider: string | undefined
  let currentModel: string | undefined
  for (const event of events) {
    if (event.type === 'request/header') {
      currentProvider = event.data.header.config.provider
      currentModel = event.data.header.config.model
      continue
    }
    if (event.type !== 'assistant/message') continue
    const usage = event.data.usage
    if (usage === undefined || !isTokenUsage(usage)) continue
    if (currentProvider === undefined || currentModel === undefined) continue
    const key = `${currentProvider}:${currentModel}`
    const bucket = buckets.get(key)
    if (bucket === undefined) {
      buckets.set(key, {
        provider: currentProvider,
        model: currentModel,
        messages: 1,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      })
      order.push(key)
      continue
    }
    bucket.messages += 1
    bucket.inputTokens += usage.inputTokens
    bucket.outputTokens += usage.outputTokens
    bucket.cacheReadTokens += usage.cacheReadTokens ?? 0
    bucket.cacheWriteTokens += usage.cacheWriteTokens ?? 0
  }
  let totalUsd = 0
  const perModel: CostModelTotal[] = order.map((key) => {
    // The typed Map guarantees the bucket exists for every key we pushed.
    const bucket = buckets.get(key) as CostBucket
    const usage: TokenUsage = {
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cacheReadTokens: bucket.cacheReadTokens,
      cacheWriteTokens: bucket.cacheWriteTokens,
    }
    const price = resolvePrice(table, bucket.provider, bucket.model)
    const priced = price !== undefined
    const costUsd = priced ? callCost(usage, price) : 0
    totalUsd += costUsd
    return { ...bucket, costUsd, priced }
  })
  return { perModel, totalUsd }
}

/**
 * Render one decision model's confirmed usage, its agreed cost, and — when the
 * ledger still holds a reservation — the unconfirmed upper bound on its own
 * line, so a reader never mistakes a reservation for settled spend.
 * @param model - the folded decision bucket.
 * @returns the model block as one multi-line string.
 */
function formatDecisionModel(model: CostDecisionModelTotal): string {
  const lines = [
    `${model.provider}/${model.model}`,
    `  Attempts: ${model.attempts}`,
    `  Confirmed: ${model.inputTokens} input + ${model.outputTokens} output`,
    model.priced
      ? `  Confirmed cost: ${formatUsd(model.costUsd)}`
      : '  Confirmed cost: unpriced (no price column configured)',
  ]
  if (model.reservedInputTokens > 0 || model.reservedOutputTokens > 0) {
    lines.push(`  Reserved upper bound, unconfirmed: ${model.reservedInputTokens} input + ${model.reservedOutputTokens} output`)
  }
  return lines.join('\n')
}

/**
 * Render the combined grand total. It reads as an exact figure ONLY when every
 * bucket is priced, no reservation stayed unconfirmed, and the decision ledger
 * is complete; otherwise it prints the confirmed subtotal plus the reasons it
 * cannot be exact, and never a single fabricated number.
 * @param report - the generative fold result owning the section.
 * @param decisions - the folded decision section.
 * @returns the grand-total lines.
 */
function formatGrandTotal(report: CostReport, decisions: CostDecisionSection): string[] {
  const split = `generative ${formatUsd(report.totalUsd)} + SystemOne decisions ${formatUsd(decisions.confirmedUsd)}`
  const total = formatUsd(report.totalUsd + decisions.confirmedUsd)
  const reasons = [...decisions.incompleteReasons]
  if (decisions.hasUnconfirmed) reasons.push('SystemOne usage stayed unconfirmed (reserved upper bound only)')
  if (decisions.hasUnpriced) reasons.push('a SystemOne decision model has no configured price')
  const unpricedGenerative = report.perModel.filter(model => !model.priced)
  if (unpricedGenerative.length > 0) {
    const names = unpricedGenerative.map(model => `${model.provider}/${model.model}`).join(', ')
    reasons.push(`no configured price for generative ${names}`)
  }
  if (reasons.length === 0) return [`Grand total (confirmed): ${total} (${split})`]
  return [
    `Grand total: incomplete — confirmed subtotal ${total} (${split})`,
    `Incomplete because: ${reasons.join('; ')}. No exact total cost is available.`,
  ]
}

/**
 * Render the `SystemOne decisions` section: per-model confirmed usage and cost,
 * the reserved upper bounds, the confirmed subtotal and — after it — the
 * combined grand total.
 * @param report - the generative fold result owning the section.
 * @param decisions - the folded decision section.
 * @returns the section lines.
 */
function formatDecisionSection(report: CostReport, decisions: CostDecisionSection): string[] {
  const lines = ['SystemOne decisions', '']
  if (decisions.perModel.length === 0) {
    lines.push('No decisions recorded for this session.')
  } else {
    for (const model of decisions.perModel) lines.push(formatDecisionModel(model))
  }
  lines.push('')
  lines.push(`Confirmed subtotal (SystemOne decisions): ${formatUsd(decisions.confirmedUsd)}`)
  if (decisions.hasUnconfirmed) {
    lines.push('Reserved upper bounds above are unconfirmed: they are not part of the confirmed subtotal.')
  }
  if (decisions.hasUnpriced) {
    lines.push('Unpriced: at least one decision model has no configured price column, so its usage is in no subtotal.')
  }
  if (decisions.incomplete) {
    lines.push(`Incomplete: ${decisions.incompleteReasons.join('; ')}. No exact total is available.`)
  }
  lines.push('')
  lines.push(...formatGrandTotal(report, decisions))
  return lines
}

/**
 * Render the fold result as human shell text. Empty reports say so directly
 * instead of listing a useless zero-only table; unpriced models report their
 * usage with an explicit no-price marker. The generative section keeps its own
 * algorithm and total; an optional `SystemOne decisions` section follows it
 * and the grand total distinguishes a confirmed subtotal from an incomplete one.
 * @param report - the fold result.
 * @returns the multi-line report text.
 */
export function formatCostReport(report: CostReport): string {
  const decisions = report.decisions
  if (report.perModel.length === 0 && decisions === undefined) {
    return 'No usage data yet; no model calls have recorded token accounting.'
  }
  const lines = ['Usage and cost by model', '']
  let totalTokens = 0
  for (const model of report.perModel) {
    const billed = model.inputTokens + model.cacheReadTokens + model.cacheWriteTokens
    totalTokens += billed + model.outputTokens
    lines.push([
      `${model.provider}/${model.model}`,
      `  Calls: ${model.messages}`,
      `  Input: ${model.inputTokens} (uncached) + ${model.cacheReadTokens} (cache-read) + ${model.cacheWriteTokens} (cache-write)`,
      `  Output: ${model.outputTokens}`,
      model.priced ? `  Cost: ${formatUsd(model.costUsd)}` : '  Cost: no price configured',
    ].join('\n'))
  }
  if (report.perModel.length === 0) {
    lines.push('No generative model usage recorded for this session.')
  } else {
    lines.push('')
    lines.push(`Total: ${totalTokens} tokens, ${formatUsd(report.totalUsd)}`)
  }
  if (decisions !== undefined) {
    lines.push('')
    lines.push(...formatDecisionSection(report, decisions))
  }
  return lines.join('\n')
}
