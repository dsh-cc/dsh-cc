/**
 * Pre-registered metric math for the tool-discovery activation eval
 * (`docs/plans/2026-11-12-tool-discovery-activation.md`).
 *
 * Shared by every arm of `scripts/eval-discovery.mjs`: the `judge-stub` arm
 * (the deterministic CI gate) and the `live` arm (evidence) both reduce a run
 * to booleans or counts and score them through these helpers, so a number is
 * never produced by two different pieces of arithmetic.
 *
 * The module is pure and dependency-free (node stdlib only, no I/O): the
 * metric definitions below ARE the pre-registration, so they must not drift
 * once the eval has been run.
 */

import { createHash } from 'node:crypto'

/** Stable hex digest used as the held-out split key (no ordering leakage). */
const sha1Hex = (value) => createHash('sha1').update(String(value), 'utf8').digest('hex')

/**
 * Micro-F1 over (query, candidate) pairs, restricted by the caller to the
 * candidates the judge actually admitted.
 *
 * Micro rather than macro: every pair is one observation, so a query with many
 * candidates and a query with one carry proportional weight. True negatives are
 * excluded arithmetically, which matches the scope of judgment — a denied
 * candidate is never shown to the judge, so scoring it would measure permission
 * gating rather than judge quality.
 *
 * Zero-denominator semantics are part of the pre-registration: a slice with no
 * gold positives AND no predictions has an UNDEFINED F1 (null), not 0 — that is
 * how the negative-only class stays exempt from the per-class F1 floor and is
 * gated on its own false-activation / exact-set lines instead. Likewise
 * precision is null with no predicted positives and recall is null with no gold
 * positives.
 *
 * @param {readonly {gold: boolean, predicted: boolean}[]} pairs
 *   One entry per (query, candidate) pair.
 * @returns {{
 *   f1: number | null,
 *   precision: number | null,
 *   recall: number | null,
 *   tp: number,
 *   fp: number,
 *   fn: number,
 * }} F1 plus its components; f1/precision/recall are null where undefined.
 */
export function microF1(pairs) {
  let tp = 0
  let fp = 0
  let fn = 0
  for (const pair of pairs) {
    if (pair.gold && pair.predicted) tp += 1
    else if (!pair.gold && pair.predicted) fp += 1
    else if (pair.gold && !pair.predicted) fn += 1
  }
  const precision = tp + fp === 0 ? null : tp / (tp + fp)
  const recall = tp + fn === 0 ? null : tp / (tp + fn)
  const f1 = precision === null || recall === null || precision + recall === 0
    ? null
    : (2 * precision * recall) / (precision + recall)
  return { f1, precision, recall, tp, fp, fn }
}

/**
 * Mean exact-set accuracy over items, i.e. the fraction of queries whose
 * activated candidate SET equals the gold set exactly (order-insensitive).
 *
 * This is the strict companion to micro-F1: it is the line the negative-only
 * class must clear at 1.0, where no positive exists to make F1 meaningful and a
 * single spurious activation is the whole failure mode. Duplicates in either
 * list collapse, because activation is a set, not a multiset.
 *
 * @param {readonly {predicted: readonly string[], gold: readonly string[]}[]} items
 * @returns {number | null} Accuracy in [0, 1], or null for an empty input
 *   (accuracy over zero items is undefined, not 0).
 */
export function exactSetAccuracy(items) {
  if (items.length === 0) return null
  let exact = 0
  for (const item of items) {
    const predicted = new Set(item.predicted)
    const gold = new Set(item.gold)
    let equal = predicted.size === gold.size
    if (equal) {
      for (const member of gold) {
        if (!predicted.has(member)) {
          equal = false
          break
        }
      }
    }
    if (equal) exact += 1
  }
  return exact / items.length
}

/**
 * False-activation rate: activated candidates over the candidate catalog,
 * aggregated across cases.
 *
 * This gates the negative-only class (design pass line: <= 0.10), where the harm
 * is loading irrelevant tools rather than missing a relevant one. Counts, not a
 * mean of per-case rates, so a large catalog case dominates a tiny one — the
 * cost that matters is total context spent. A catalog with no candidates has an
 * undefined rate (null), not 0.
 *
 * @param {readonly number[]} activatedCounts Per-case activated candidate counts.
 * @param {readonly number[]} candidateCounts Per-case catalog candidate counts,
 *   parallel to `activatedCounts`.
 * @returns {{rate: number | null, activated: number, candidates: number}}
 *   The aggregate ratio plus its numerator and denominator.
 */
export function falseActivationRate(activatedCounts, candidateCounts) {
  const length = Math.min(activatedCounts.length, candidateCounts.length)
  let activated = 0
  let candidates = 0
  for (let i = 0; i < length; i += 1) {
    activated += activatedCounts[i]
    candidates += candidateCounts[i]
  }
  return { rate: candidates === 0 ? null : activated / candidates, activated, candidates }
}

/**
 * Nearest-rank percentiles (p50, p90, max) of per-case samples such as
 * activation counts or per-query latency.
 *
 * Reported alongside the gated rates because the mean hides the tail: the cost
 * bound of the feature is set by the slowest batch, not the average one.
 * Nearest-rank is used deliberately (index = ceil(p/100 * n) - 1, clamped) so a
 * percentile is always an observed value — no interpolation, hence no
 * dependence on the sample's local shape. All fields are null for an empty
 * input.
 *
 * @param {readonly number[]} values Samples; not mutated.
 * @returns {{p50: number | null, p90: number | null, max: number | null}}
 */
export function percentiles(values) {
  if (values.length === 0) return { p50: null, p90: null, max: null }
  const sorted = [...values].sort((left, right) => left - right)
  const nearestRank = (percent) => {
    const index = Math.ceil((percent / 100) * sorted.length) - 1
    return sorted[Math.min(sorted.length - 1, Math.max(0, index))]
  }
  return { p50: nearestRank(50), p90: nearestRank(90), max: sorted[sorted.length - 1] }
}

/**
 * One-sided Wilson score lower bound on a binomial proportion.
 *
 * The later shadow-audit statistic: the flip gate is "judge-correct rate with a
 * one-sided 95% Wilson lower bound >= 0.60" over manually labeled
 * shadow-vs-lexical disagreements. A Wilson bound rather than a bare point rate
 * because 70% of 30 observations carries a lower bound near 52% — the point
 * estimate alone would pass a gate the evidence does not support. The default
 * z = 1.645 is the one-sided 95% quantile.
 *
 * The result is clamped into [0, 1]; with zero observations the proportion is
 * undefined (null), not 0.
 *
 * @param {number} successes Labeled-correct observations.
 * @param {number} total Labeled observations.
 * @param {number} [z] Normal quantile; 1.645 is the one-sided 95% bound.
 * @returns {number | null} Lower bound in [0, 1], or null when total is 0.
 */
export function wilsonLowerBound(successes, total, z = 1.645) {
  if (total === 0) return null
  const proportion = successes / total
  const zSquared = z * z
  const centre = proportion + zSquared / (2 * total)
  const margin = z * Math.sqrt((proportion * (1 - proportion)) / total + zSquared / (4 * total * total))
  const bound = (centre - margin) / (1 + zSquared / total)
  return Math.min(1, Math.max(0, bound))
}

/**
 * Deterministic 2/3 tune / 1/3 held-out split of the corpus.
 *
 * The pre-registered policy: thresholds are tuned only on the tune split and
 * the held-out split is evaluated once, at flip time, so the reported number is
 * not the one the thresholds were fitted to. The split key is the sha1 hex of
 * the case id, never the case id itself, so the ordering neither follows nor
 * reveals authoring order, class grouping, or alphabet — while staying fully
 * reproducible on every run. Ties break on the raw id for total stability.
 *
 * Pure: the input array and its members are never mutated, and the same input
 * always yields the same split.
 *
 * @template {{id: string}} T
 * @param {readonly T[]} cases Corpus cases; each needs a unique `id`.
 * @param {{tuneFraction?: number}} [options] Tune share, default 2/3.
 * @returns {{tune: T[], heldOut: T[]}} At least one tune case when the corpus
 *   is non-empty; the two splits partition the input exactly.
 */
export function splitCorpus(cases, options = {}) {
  const tuneFraction = options.tuneFraction ?? 2 / 3
  const ordered = [...cases].sort((left, right) => {
    const leftKey = sha1Hex(left.id)
    const rightKey = sha1Hex(right.id)
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1
    if (left.id === right.id) return 0
    return left.id < right.id ? -1 : 1
  })
  const tuneCount = ordered.length === 0
    ? 0
    : Math.min(ordered.length, Math.max(1, Math.ceil(ordered.length * tuneFraction)))
  return { tune: ordered.slice(0, tuneCount), heldOut: ordered.slice(tuneCount) }
}
