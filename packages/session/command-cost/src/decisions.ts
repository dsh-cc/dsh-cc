/**
 * `/cost` SystemOne-decision merge: read the session's decision-usage ledger,
 * fold its leases into per-model confirmed and reserved tokens, and price the
 * confirmed part against the same deployment price table as generative usage.
 *
 * Design (docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md
 * §"Ledger, privacy and reporting"): the ledger is deduplicated by `eventId`;
 * every attempt of one decision counts; unknown/unsettled usage is reported as
 * a reserved upper bound and never joins the confirmed subtotal; a model with
 * no configured price reads as unpriced, never `$0`; a torn tail, a corrupt
 * line or a durably frozen quota marks the totals incomplete so no exact total
 * cost is fabricated. Reads are read-only and never throw.
 * @module @dsh-cc/command-cost/decisions
 */

import {
  decisionUsageDir,
  projectDecisionLedger,
  readDecisionLedger,
  usageFilePath,
} from '@dsh-cc/decision-usage'
import type { DecisionLedgerReport } from '@dsh-cc/decision-usage'
import { callCost, resolvePrice } from './cost.ts'
import type { CostDecisionModelTotal, CostDecisionSection, ModelPrice } from './cost.ts'

/** The ledger slice the fold consumes (a `DecisionLedgerReport` satisfies it). */
export type DecisionUsageEvidence = Pick<DecisionLedgerReport, 'rows' | 'tornTail' | 'corruptLines'>

/** One complete, schema-valid ledger row as the shared reader types it. */
export type DecisionCostRow = DecisionLedgerReport['rows'][number]

/** Mutable accumulator for one (provider, pricing model) decision bucket. */
interface DecisionBucket {
  provider: string
  model: string
  attempts: number
  inputTokens: number
  outputTokens: number
  reservedInputTokens: number
  reservedOutputTokens: number
}

/**
 * Drop repeated `eventId` rows. The ledger writer may append the same event
 * once per crash-recovered retry; accounting counts each event exactly once.
 * The FIRST occurrence wins (file order = ledger order).
 * @param rows - complete ledger rows in file order.
 * @returns the same rows with later duplicates removed, order preserved.
 */
export function dedupeDecisionRows(rows: readonly DecisionCostRow[]): DecisionCostRow[] {
  const seen = new Set<string>()
  const unique: DecisionCostRow[] = []
  for (const row of rows) {
    if (seen.has(row.eventId)) continue
    seen.add(row.eventId)
    unique.push(row)
  }
  return unique
}

/**
 * Fold decision-usage ledger evidence into per-model decision totals. Rows are
 * deduplicated by `eventId` first, then projected with the shared lease
 * accounting: a lease is CONFIRMED only when it settled `actual` (its actual
 * tokens are priced); an `unknown` or still-unsettled lease keeps its
 * reservation as a reserved UPPER BOUND and stays out of the confirmed
 * subtotal; a `not-dispatched` lease refunds to nothing.
 *
 * The pricing key is `actualModel` when the attempt has a response, else
 * `requestedModel`, matched together with `provider` against the deployment
 * table — input and output are priced separately, so a service is never
 * silently free.
 * @param evidence - the read ledger: rows plus its torn/corrupt markers.
 * @param table - deployment price table from Config.
 * @returns the decisions section, or undefined when nothing was recorded.
 */
export function foldDecisionUsage(
  evidence: DecisionUsageEvidence,
  table: readonly ModelPrice[],
): CostDecisionSection | undefined {
  const hasCorruption = evidence.tornTail || evidence.corruptLines.length > 0
  if (evidence.rows.length === 0 && !hasCorruption) return undefined
  const usage = projectDecisionLedger(dedupeDecisionRows(evidence.rows))
  const buckets = new Map<string, DecisionBucket>()
  const order: string[] = []
  for (const lease of usage.leases) {
    const confirmed = lease.settledKind === 'actual'
    const unconfirmed = lease.settledKind === 'unknown' || lease.settledKind === undefined
    // A counted attempt (even a valid 0-token response) is real usage; a ghost
    // lease with no reserve, no dispatch and no response carries no mass.
    if (!lease.countedAsAttempt && !confirmed) continue
    const provider = lease.provider ?? ''
    const model = lease.actualModel ?? lease.requestedModel ?? ''
    const key = `${provider}:${model}`
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = {
        provider,
        model,
        attempts: 0,
        inputTokens: 0,
        outputTokens: 0,
        reservedInputTokens: 0,
        reservedOutputTokens: 0,
      }
      buckets.set(key, bucket)
      order.push(key)
    }
    if (lease.countedAsAttempt) bucket.attempts += 1
    if (confirmed) {
      bucket.inputTokens += lease.actualInputTokens ?? lease.retainedInputTokens
      bucket.outputTokens += lease.actualOutputTokens ?? lease.retainedOutputTokens
    } else if (unconfirmed) {
      bucket.reservedInputTokens += lease.retainedInputTokens
      bucket.reservedOutputTokens += lease.retainedOutputTokens
    }
  }
  let confirmedUsd = 0
  let hasUnconfirmed = false
  let hasUnpriced = false
  const perModel: CostDecisionModelTotal[] = order.map((key) => {
    // The typed Map guarantees the bucket exists for every key we pushed.
    const bucket = buckets.get(key) as DecisionBucket
    const price = resolvePrice(table, bucket.provider, bucket.model)
    const priced = price !== undefined
    const costUsd = priced
      ? callCost({ inputTokens: bucket.inputTokens, outputTokens: bucket.outputTokens }, price)
      : 0
    if (priced) confirmedUsd += costUsd
    else hasUnpriced = true
    if (bucket.reservedInputTokens > 0 || bucket.reservedOutputTokens > 0) hasUnconfirmed = true
    return { ...bucket, costUsd, priced }
  })
  const incompleteReasons: string[] = []
  if (evidence.tornTail) incompleteReasons.push('the ledger tail is torn (a crash mid-append)')
  if (evidence.corruptLines.length > 0) {
    incompleteReasons.push(`${evidence.corruptLines.length} corrupt ledger line(s)`)
  }
  if (usage.frozen) {
    incompleteReasons.push(
      `the session quota is frozen${usage.freezeReasonCode === undefined ? '' : ` (${usage.freezeReasonCode})`}`,
    )
  }
  return {
    perModel,
    confirmedUsd,
    hasUnconfirmed,
    hasUnpriced,
    incomplete: incompleteReasons.length > 0,
    incompleteReasons,
    attemptsUsed: usage.attemptsUsed,
    retainedInputTokens: usage.retainedInputTokens,
    retainedOutputTokens: usage.retainedOutputTokens,
  }
}

/**
 * Read one session's decision-usage ledger and fold it. Missing host facts (no
 * dsh-home resolver, no session cwd, no session id) or a missing ledger mean
 * the section is simply ABSENT; any read fault degrades the same way. Never
 * throws — `/cost` must render the generative section regardless.
 * @param home - dsh-home resolver from the host context, when available.
 * @param scope - the session's ledger scope (project key and raw session id).
 * @param table - deployment price table from Config.
 * @returns the decisions section, or undefined when nothing is available.
 */
export async function readDecisionCostSection(
  home: (() => string) | undefined,
  scope: { readonly projectKey: string; readonly sessionId: string } | undefined,
  table: readonly ModelPrice[],
): Promise<CostDecisionSection | undefined> {
  if (home === undefined || scope === undefined) return undefined
  try {
    const dir = decisionUsageDir(home(), scope.projectKey, scope.sessionId)
    return foldDecisionUsage(await readDecisionLedger(usageFilePath(dir)), table)
  } catch {
    // Unreadable ledger (perm, torn dir, bad home): report no decisions rather
    // than failing the command; the generative section still renders.
    return undefined
  }
}
