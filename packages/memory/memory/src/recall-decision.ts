/**
 * SystemOne memory-recall selection, PURE half (design
 * docs/plans/2026-11-02-systemone-03-memory-recall.md §"Candidate identity and
 * input contract", §"Complete batching and deterministic filtering").
 *
 * The pure half owns the contracts and everything that can be decided without a
 * runner: per-pool candidate identity (stable `mNNNN` IDs), the deterministic
 * probability filter with its whole-pool grey-zone signal, the complete batch
 * plan checked against the run's batch-count cap, and the remaining-deadline
 * degrade helper. The adapter half (request assembly, `identifyRoute`, answer
 * validation, the legacy ID adapter, the composed dispatch) lives in
 * `recall-decision-runner.ts` so neither module outgrows the per-file budget.
 *
 * Privacy: `RecallTopic.path` is host-only — it exists to map a selection back
 * to a file and must never be sent to the runner. Only scope, filename, name and
 * description cross the wire.
 *
 * @module @dsh-cc/memory/recall-decision
 */

import type { DecisionScope } from '@dsh-cc/systemone'
import { MAX_RECALL_MEMORIES } from './recall-selector.ts'
import type { RecallIndexedLayers } from './recall-preselect.ts'

/** The layer a candidate was scanned from. */
export type RecallScope = 'workspace' | 'global'

/** One candidate in a recall pool, after ID assignment. */
export interface RecallTopic {
  /** `m0000`, `m0001`, …; interpreted only within this pool. */
  id: string
  scope: RecallScope
  /** Host-only canonical absolute path — must never be sent to the runner. */
  path: string
  filename: string
  name: string
  description: string
  /** Verified by the host on re-read; content itself is never sent. */
  contentHash: string
}

/** One candidate as scanned, before the host assigns its pool-local ID. */
export type RecallTopicSeed = Omit<RecallTopic, 'id'>

/** Everything one selection request needs (host-side view). */
export interface RecallDecisionInput {
  query: string
  recentTools: readonly string[]
  topics: readonly RecallTopic[]
  /**
   * Per-layer memory-index membership for the pre-selection tie-break.
   * Host-local only: never enters the wire state or the legacy manifest,
   * and the legacy fallback paths ignore it. Absent is exactly the shipped
   * pre-selection order.
   */
  indexedFilenames?: Readonly<RecallIndexedLayers>
}

/**
 * The outcome of one selection request.
 *
 * `judged` is the size of the decision arm's judged pool: the post-preselection,
 * post-trim candidate count. It is 0 when no plan existed (mode off, no route,
 * a pool that cannot be admitted at all), so a caller can always record
 * `pool` vs `judged` without re-deriving the pre-selection.
 */
export type RecallSelection =
  | { kind: 'selected'; ids: string[]; probabilities: Record<string, number>; judged: number; greyDropped: number }
  | { kind: 'fallback'; reason: string; judged: number }
  | { kind: 'cancelled' }

/**
 * The SystemOne selector contract. `DecisionScope` comes from S1-02 — consumers
 * never assemble projectKey/sessionId/agentId themselves.
 */
export interface RecallDecisionSelector {
  select(input: RecallDecisionInput, scope: DecisionScope, signal: AbortSignal): Promise<RecallSelection>
}

/**
 * Compare two strings by UTF-8 byte order (never locale order), so ID assignment
 * and tie-breaking are identical on every host.
 * @param a - left string.
 * @param b - right string.
 * @returns negative, zero or positive per byte order.
 */
export function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** Zero-based index → pool-local ID (`m0000`). */
function recallTopicId(index: number): string {
  return `m${String(index).padStart(4, '0')}`
}

/**
 * Assign pool-local IDs: sort by scope (workspace first) and then by the UTF-8
 * byte order of the canonical absolute path, then number the result `m0000`,
 * `m0001`, … Two same-named `rules.md` files in different layers therefore get
 * different IDs and keep their identity.
 * @param topics - the scanned candidates (id-less).
 * @returns the candidates in canonical order, each carrying its ID.
 */
export function assignRecallTopicIds(topics: readonly RecallTopicSeed[]): RecallTopic[] {
  return [...topics]
    .sort((a, b) =>
      Number(a.scope === 'global') - Number(b.scope === 'global') ||
      compareUtf8(a.path, b.path),
    )
    .map((topic, index) => ({ id: recallTopicId(index), ...topic }))
}

/** One candidate's probability, as returned by the decision model. */
export interface RecallProbabilityRow {
  id: string
  probability: number
  scope: RecallScope
}

/** The per-candidate grey-zone outcome: the kept IDs plus how many were dropped. */
export interface RecallSelectionIds {
  /** The selected IDs (at most {@link MAX_RECALL_MEMORIES}), possibly empty. */
  ids: string[]
  /** How many judged rows fell inside the open grey band (lo, hi). */
  greyDropped: number
}

/**
 * Deterministic filter over the model's probabilities.
 *
 * `lo` is an explicit exclusion and `hi` an explicit inclusion. A probability
 * STRICTLY inside the open interval `(lo, hi)` is a per-candidate
 * uncertainty: the row is DROPPED from selection (never included), but it no
 * longer poisons the whole run — a confident subset delivers terminally
 * (#366's 97-256 band rule), and an empty result flows into the caller's
 * `empty-selection` fallback over the full pool. `greyDropped` counts every
 * in-band judged row, independent of the selection cap, so soak telemetry can
 * distinguish all-grey (`ids: [], greyDropped > 0`) from all-low
 * (`ids: [], greyDropped: 0`).
 * @param rows - probabilities for the complete candidate pool.
 * @param lo - the exclusion threshold (`excludeProbability`).
 * @param hi - the inclusion threshold (`includeProbability`).
 * @returns the kept IDs and the dropped count; never `undefined`.
 */
export function selectIds(
  rows: readonly RecallProbabilityRow[],
  lo: number,
  hi: number,
): RecallSelectionIds {
  const greyDropped = rows.filter(r => r.probability > lo && r.probability < hi).length
  const ids = rows.filter(r => r.probability >= hi).sort((a, b) =>
    b.probability - a.probability ||
    Number(a.scope === 'global') - Number(b.scope === 'global') ||
    Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
  ).slice(0, MAX_RECALL_MEMORIES).map(r => r.id)
  return { ids, greyDropped }
}

/** Why a recall run degrades instead of dispatching SystemOne requests. */
export type RecallBatchDegradeReason =
  | 'invalid-limits'
  | 'candidates-over-limit'
  | 'route-question-capacity'
  | 'batch-count-over-cap'

/** The limits a batch plan is computed from. */
export interface RecallBatchLimits {
  /** Configured `batch-size` (1-32). */
  batchSize: number
  /**
   * Configured `max-candidates` (1-256); above it {@link planRecallBatches}
   * degrades. The selector no longer calls it that way: it pre-selects a
   * deterministic top-K first (issue #363), so this guard serves direct callers.
   */
  maxCandidates: number
  /** The route identity's advertised per-request question ceiling. */
  maxQuestions: number
}

/** A complete batch plan (candidate IDs in dispatch order). */
export type RecallBatchPlan =
  | { kind: 'planned'; batches: string[][]; cap: number }
  | { kind: 'degraded'; reason: RecallBatchDegradeReason }

/**
 * The run's batch-count cap: `ceil(maxCandidates / batchSize)`. At most this many
 * batches may be dispatched sequentially; a plan needing more degrades whole.
 * @param maxCandidates - configured `max-candidates`.
 * @param batchSize - configured `batch-size`.
 * @returns the batch-count cap.
 */
export function recallBatchCountCap(maxCandidates: number, batchSize: number): number {
  return Math.ceil(maxCandidates / batchSize)
}

/**
 * Plan the complete batch list (design §"Complete batching and deterministic
 * filtering").
 *
 * Every candidate enters exactly one batch, in full, with no truncation; each
 * batch carries at most `min(batchSize, route maxQuestions)` questions. The
 * planned batch count is compared DIRECTLY against the cap
 * {@link recallBatchCountCap} before any dispatch: exceeding it degrades the
 * whole run instead of sending partial batches.
 * @param ids - every candidate ID of this pool, in canonical order.
 * @param limits - the configured limits plus the route's question ceiling.
 * @returns the planned batches, or the degrade reason.
 */
export function planRecallBatches(ids: readonly string[], limits: RecallBatchLimits): RecallBatchPlan {
  const { batchSize, maxCandidates, maxQuestions } = limits
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || !Number.isSafeInteger(maxCandidates) || maxCandidates < 1) {
    return { kind: 'degraded', reason: 'invalid-limits' }
  }
  if (!Number.isSafeInteger(maxQuestions) || maxQuestions < 1) {
    return { kind: 'degraded', reason: 'route-question-capacity' }
  }
  // A pool above the candidate limit is never partly dispatched.
  if (ids.length > maxCandidates) return { kind: 'degraded', reason: 'candidates-over-limit' }
  const perBatch = Math.min(batchSize, maxQuestions)
  const batches: string[][] = []
  for (let start = 0; start < ids.length; start += perBatch) {
    batches.push(ids.slice(start, start + perBatch))
  }
  const cap = recallBatchCountCap(maxCandidates, batchSize)
  if (batches.length > cap) return { kind: 'degraded', reason: 'batch-count-over-cap' }
  return { kind: 'planned', batches, cap }
}

/**
 * The smallest remaining slice of the total deadline that is still worth a
 * dispatch: below it the whole run degrades (design, doc-verbatim "fewer than
 * 100 milliseconds remain").
 */
export const MIN_RECALL_BATCH_REMAINING_MS = 100

/**
 * Whether the total deadline is too far spent to start another batch.
 * @param remainingMs - milliseconds left of the run's total `timeoutMs`.
 * @returns `true` when the run must degrade instead of dispatching.
 */
export function shouldDegradeForDeadline(remainingMs: number): boolean {
  return remainingMs < MIN_RECALL_BATCH_REMAINING_MS
}
