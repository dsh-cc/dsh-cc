/**
 * Receipt-row sampling harness (VWA plan §8, frozen convention).
 *
 * Sampling = of the receipt rows produced in a period:
 *   - dogfood: 20% with min 5 per batch (ceil → at least 5 whenever the
 *     ceil itself is smaller);
 *   - post-acceptance: 5% (ceil), min 1.
 * K = 20 expected atomic facts per receipt row (SAFE convention; the
 * constant comes from arXiv 2403.18802's expected-fact setting — it is a
 * METRIC parameter for F1@K, NEVER a sampling ratio).
 * Labels: supported | partially | unsupported | irrelevant.
 * F1@K is a metric over per-fact labels, never a sampling ratio.
 *
 * Judge-lane budget table (§8: caps live here, as numbers, and are
 * recalibrated by dogfood — FIRST-BUDGET ESTIMATES, not measured values):
 *   - per-batch judge calls: 40 (20 sampled rows × up to 2 calls: atomic
 *     facts + verdicts) — first-budget estimate;
 *   - per-batch token cap: 200_000 total (input+output across the batch)
 *     — first-budget estimate;
 *   - per-row atomic-fact cap: K = 20 facts — frozen by the SAFE convention.
 * The judge tier itself is NOT wired at P2 (§4.4); these caps are the
 * contract the future judge lane must respect.
 *
 * @module @dsh-cc/vwa-eval/sampling
 */

/** First-budget estimates; recalibrate after one dogfood week (§8). */
export const BUDGET = {
  /** Max judge-lane calls per sampling batch (first-budget estimate). */
  judgeCallsPerBatch: 40,
  /** Max total tokens (in+out) per sampling batch (first-budget estimate). */
  tokensPerBatch: 200_000,
} as const

/** Dogfood sampling rate (§8, frozen). */
export const DOGFOOD_RATE = 0.2
/** Minimum sampled receipt rows per dogfood batch (§8, frozen). */
export const DOGFOOD_MIN = 5
/** Post-acceptance sampling rate (§8, frozen). */
export const POST_RATE = 0.05
/** Expected atomic facts per row — SAFE convention (arXiv 2403.18802). METRIC parameter, never a sampling ratio. */
export const K_ATOMIC_FACTS = 20

export const SAMPLING_LABELS = ['supported', 'partially', 'unsupported', 'irrelevant'] as const
export type SamplingLabel = (typeof SAMPLING_LABELS)[number]

export type SamplingPhase = 'dogfood' | 'post-acceptance'

/**
 * Receipt rows to sample from a batch of `batchSize` rows.
 * ceil(rate × n), with the phase's floor applied (dogfood: ≥ 5).
 */
export function sampleCount(batchSize: number, phase: SamplingPhase): number {
  const rate = phase === 'dogfood' ? DOGFOOD_RATE : POST_RATE
  const byRate = Math.ceil(batchSize * rate)
  return phase === 'dogfood' ? Math.max(byRate, DOGFOOD_MIN) : Math.max(byRate, 1)
}

/** Deterministic stride pick over receipt rows ordered by (ledger, line). */
export function pickRows<T>(rows: readonly T[], phase: SamplingPhase): T[] {
  if (rows.length === 0) return []
  const n = sampleCount(rows.length, phase)
  const picked: T[] = []
  for (let i = 0; i < n; i++) {
    const row = rows[Math.floor((i * rows.length) / n)]
    if (row !== undefined) picked.push(row)
  }
  return picked
}

/**
 * F1@K over per-fact labels for ONE receipt row, given up to K facts
 * (first K = 20). A fact "counts" when its label is supported or
 * partially (SAFE's soft handling: partial support is half credit —
 * ponytail: binary credit here, the judge design (§4.4, later) may
 * refine to 0.5-weighted partials).
 */
export function f1AtK(labels: SamplingLabel[], k: number = K_ATOMIC_FACTS): { precision: number; recall: number; f1: number } {
  const slice = labels.slice(0, k)
  const good = slice.filter((l) => l === 'supported' || l === 'partially').length
  const total = K_ATOMIC_FACTS
  const precision = slice.length === 0 ? 0 : good / slice.length
  const recall = good / total
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return { precision, recall, f1 }
}
