/**
 * The §16.2 lane-2 (bound-artifact) turn-end branch of the evaluator
 * (design docs/plans/2026-10-16-vwa-evidence-argument.md): frozen-check
 * evaluation, the closed nudge trigger, v2 receipt assembly + read-back,
 * the stale-binding nudge, and the synchronous inject. Split from
 * evaluator.ts purely for the 500-line budget — the inject point stays the
 * single vwa-evidence one (source kind 'vwa-evidence').
 *
 * @module @dsh-cc/vwa-evidence/bound-eval
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  lastV2ReceiptHash,
  nudgeBudgetConsumed,
  sha256Hex,
  writeReceiptV2,
  type AnyReceiptRow,
  type ReceiptV2,
} from './receipt.ts'
import {
  boundNudgeTargets,
  buildReceiptV2,
  readCurrentProject,
  writeBoundReport,
  type DeliveryCheckLike,
} from './vwa-delivery.ts'
import type { EvalEvent, EvalAgent, EvaluateTurnOptions } from './evaluator.ts'
import { VWA_EVIDENCE_SOURCE_KIND } from './evaluator.ts'

/** One project-bound artifact entry, keyed by realpath. */
export interface BoundEntry {
  projectId: string
  artifactId: string
  absolutePath: string
}

/** Bound artifacts of the current project (§16.2 step 2); empty without a provider + valid pointer. */
export function boundArtifactMap(
  options: EvaluateTurnOptions,
  _events: readonly EvalEvent[],
  debug: (message: string) => void,
): Map<string, BoundEntry> {
  const map = new Map<string, BoundEntry>()
  const provider = options.deliveryProvider
  if (provider === undefined) return map
  try {
    const projectId = readCurrentProject(options.workspaceRoot)
    if (projectId === undefined) return map
    for (const artifact of provider.listBoundArtifacts(projectId)) {
      const absolutePath = isAbsolute(artifact.path) ? artifact.path : join(options.workspaceRoot, artifact.path)
      // realpath-unknown here (sync context); the consumer re-resolves.
      if (!map.has(absolutePath)) {
        map.set(absolutePath, { projectId, artifactId: artifact.artifactId, absolutePath })
      }
    }
  } catch (error: unknown) {
    debug(`vwa-evidence: bound-artifact discovery failed (lane-1-only turn): ${String(error)}`)
  }
  return map
}

export interface BoundEvalContext {
  sessionId: string
  turnKey: string
  ledgerPath: string
  rows: readonly AnyReceiptRow[]
  events: readonly EvalEvent[]
  artifactPath: string
  boundEntry: BoundEntry
}

export interface BoundOutcome {
  artifactId: string
  receiptWritten: boolean
  nudged: boolean
}

/**
 * Lane-2 turn-end evaluation (§16.2 step 4–7): the provider freezes the
 * check, the report is written first (§16.1a), then the v2 receipt row is
 * appended and read back by (receiptId, receiptHash). Never-run / pending
 * reviews ⇒ `overall:abstained` + pendingRunIds and NO nudge; the closed
 * trigger boolean is (mechanical fail) ∪ (layer fail ∪ active blocker/major
 * not disagreement) ∪ (stale binding — the InputChangedError path). Budget
 * caps are the SHARED vwa-evidence caps (per artifact/turn ≤ 1, per turn ≤ 2,
 * session budget counting v1 + v2 rounds).
 */
export async function evaluateBoundArtifact(
  options: EvaluateTurnOptions,
  ctx: BoundEvalContext,
): Promise<BoundOutcome> {
  const debug = options.debug
  const provider = options.deliveryProvider
  if (provider === undefined) return { artifactId: ctx.boundEntry.artifactId, receiptWritten: false, nudged: false }
  options.signal?.throwIfAborted()
  let check: DeliveryCheckLike
  let evaluationId: string
  try {
    const frozen = await provider.checkForDelivery(ctx.boundEntry.projectId, ctx.boundEntry.artifactId)
    check = frozen.check
    evaluationId = frozen.evaluationId
  } catch (error: unknown) {
    // Stale binding (D16: body written via shell after binding) — no
    // receipt (the full v2 row needs the frozen check), but the closed
    // trigger's stale clause fires a budget-guarded nudge.
    debug(`vwa-evidence: delivery check failed for ${ctx.artifactPath}: ${String(error)}`)
    return await nudgeStaleBinding(options, ctx, error)
  }
  const neverRun = check.reviewRunIds.length === 0
  const pending = check.pendingRunIds.length > 0
  const reportRelative = `.dsh/vwa/${ctx.boundEntry.projectId}/reports/${check.artifactId}.md`
  // Report written FIRST (§16.1a); its hash enters the receipt.
  let report = { path: reportRelative, hash: sha256Hex('') }
  try {
    const rendered = await provider.renderReport(ctx.boundEntry.projectId, check.artifactId, evaluationId, 'markdown')
    report = writeBoundReport(options.workspaceRoot, ctx.boundEntry.projectId, rendered.text, check.artifactId)
  } catch (error: unknown) {
    debug(`vwa-evidence: report rendering failed for ${check.artifactId} (receipt carries the empty-file hash): ${String(error)}`)
  }
  const parentHash = lastV2ReceiptHash(ctx.rows, ctx.artifactPath)
  const row = buildReceiptV2({
    sessionId: ctx.sessionId,
    ts: options.now?.() ?? Date.now(),
    receiptId: `rec_${randomUUID()}`,
    projectId: ctx.boundEntry.projectId,
    artifactPath: ctx.artifactPath,
    events: ctx.events,
    workspaceRoot: options.workspaceRoot,
    parentHash,
    report,
    check,
    neverRun,
  })
  // Never-run/pending → no nudge ever (§16.2); otherwise the closed trigger.
  const trigger = !neverRun && !pending && row.overall === 'fail'
  const artifactKey = `${ctx.turnKey}|${ctx.artifactPath}`
  const sessionSpent = Math.max(nudgeBudgetConsumed(ctx.rows), options.state.latch.get(ctx.sessionId) ?? 0)
  const fire = trigger
    && !options.state.perArtifact.has(artifactKey)
    && (options.state.perTurn.get(ctx.turnKey) ?? 0) < 2
    && sessionSpent < options.settings['nudge-budget']
  const receipt: ReceiptV2 = row
  if (fire) {
    options.state.perArtifact.add(artifactKey)
    options.state.perTurn.set(ctx.turnKey, (options.state.perTurn.get(ctx.turnKey) ?? 0) + 1)
    options.state.latch.set(ctx.sessionId, Math.max(options.state.latch.get(ctx.sessionId) ?? 0, sessionSpent) + 1)
    receipt.nudge.round = 1
  }
  const written = await writeReceiptV2(ctx.ledgerPath, receipt)
  if (!written.ok) {
    // D15: a failed read-back is never presented as a receipt; the round
    // consumes no nudge and the row is NOT counted as written.
    debug(`vwa-evidence: v2 receipt read-back failed for ${ctx.artifactPath}: ${written.detail ?? '?'}`)
    return { artifactId: receipt.artifactId, receiptWritten: false, nudged: false }
  }
  if (fire) injectBoundNudge(options.agent, ctx.boundEntry.projectId, check, neverRun, debug)
  return { artifactId: receipt.artifactId, receiptWritten: true, nudged: fire }
}

/** The stale-binding nudge (D16): budget-guarded, no receipt row (no frozen check exists). */
async function nudgeStaleBinding(options: EvaluateTurnOptions, ctx: BoundEvalContext, error: unknown): Promise<BoundOutcome> {
  const artifactKey = `${ctx.turnKey}|${ctx.artifactPath}`
  const sessionSpent = Math.max(nudgeBudgetConsumed(ctx.rows), options.state.latch.get(ctx.sessionId) ?? 0)
  const fire = !options.state.perArtifact.has(artifactKey)
    && (options.state.perTurn.get(ctx.turnKey) ?? 0) < 2
    && sessionSpent < options.settings['nudge-budget']
  if (!fire) return { artifactId: ctx.boundEntry.artifactId, receiptWritten: false, nudged: false }
  options.state.perArtifact.add(artifactKey)
  options.state.perTurn.set(ctx.turnKey, (options.state.perTurn.get(ctx.turnKey) ?? 0) + 1)
  options.state.latch.set(ctx.sessionId, Math.max(options.state.latch.get(ctx.sessionId) ?? 0, sessionSpent) + 1)
  const parts = [
    `VWA evidence: bound artifact ${ctx.boundEntry.artifactId} is STALE — ${error instanceof Error ? error.message : String(error)}`,
    `suggested: re-bind the artifact in project ${ctx.boundEntry.projectId}, then run argument.review for it. (vwa-evidence)`,
  ]
  try {
    options.agent.inject?.(createUserMessage({
      content: [{ type: 'text', text: parts.join(' ') }],
      source: { kind: VWA_EVIDENCE_SOURCE_KIND },
    }))
  } catch (injectError: unknown) {
    options.debug(`vwa-evidence: inject failed: ${String(injectError)}`)
  }
  return { artifactId: ctx.boundEntry.artifactId, receiptWritten: false, nudged: true }
}

/** Synchronous inject at the single evaluator point (§16.2): targets + suggested argument.review. */
function injectBoundNudge(
  agent: EvalAgent,
  projectId: string,
  check: DeliveryCheckLike,
  neverRun: boolean,
  debug: (m: string) => void,
): void {
  const parts = [
    `VWA lane-2 review: ${check.artifactId} does not fully verify (mechanical ${check.checks.mechanical}, evidence ${check.checks.evidence}, argument ${check.checks.argument}, audit ${check.checks.audit}).`,
    ...boundNudgeTargets(projectId, check, neverRun),
    'Self-repair once, then continue. (vwa-evidence)',
  ]
  try {
    agent.inject?.(createUserMessage({
      content: [{ type: 'text', text: parts.join('\n') }],
      source: { kind: VWA_EVIDENCE_SOURCE_KIND },
    }))
  } catch (error: unknown) {
    debug(`vwa-evidence: inject failed: ${String(error)}`)
  }
}

