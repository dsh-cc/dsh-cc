/**
 * Frozen semantic scorer `humanities-scorer@1` (VWA lane-2 design
 * docs/plans/2026-10-16-vwa-evidence-argument.md §22.2).
 *
 * Pure functions only — no fs, no model calls, no imports from the
 * interaction packages. Every metric returns counts (numerator/denominator)
 * alongside the point estimate; CIs are disclosed only, never used for
 * threshold judgments.
 *
 * @module @dsh-cc/vwa-eval/scorer
 */

/** Semantic version pinned by the spec; must not drift silently. */
export const SCORER_VERSION = 'humanities-scorer@1'
/** Fixed bootstrap seed and resample count (§22.2, frozen). */
export const BOOTSTRAP_SEED = 20261016
export const BOOTSTRAP_RESAMPLES = 10_000

export const SUPPORT_CLASSES = ['direct', 'inferential', 'partial', 'contradicted', 'irrelevant'] as const
export type SupportClass = (typeof SUPPORT_CLASSES)[number]

/**
 * Lane-1 sampling label → lane-2 Support enum mapping (§22.2, frozen with
 * the scorer). Note `inferential` has no lane-1 source and `unknown` is
 * never a gold class.
 */
export const LANE1_SUPPORT_MAP: Record<'supported' | 'partially' | 'unsupported' | 'irrelevant', SupportClass> = {
  supported: 'direct',
  partially: 'partial',
  unsupported: 'contradicted',
  irrelevant: 'irrelevant',
}

/** An atomic claim as annotated in a gold case (or predicted by the extractor). */
export interface AtomicClaim {
  id: string
  /** Half-open [start, end) UTF-16 code-unit span into the body text. */
  span: [number, number]
  kind: string
  text: string
  /** Gold-only: the claim is part of the judged core set (core recall ≥0.95). */
  core?: boolean
}

/** A review finding (§6 Finding): severity drives the major-fault metrics. */
export interface ScoredFinding {
  id: string
  severity: 'blocker' | 'major' | 'minor'
}

/** A clean sample is one annotated as having no errors/gaps (§22.2). */
export interface CaseIo {
  /** Gold (human-adjudicated) claims. */
  goldClaims: AtomicClaim[]
  /** Predicted claims (the extractor under test). */
  predictedClaims: AtomicClaim[]
  /** Gold findings marking real faults. */
  goldFindings: ScoredFinding[]
  /** Predicted findings (the reviewer under test). */
  predictedFindings: ScoredFinding[]
  /** True when the case is a clean positive (no errors/gaps). */
  clean: boolean
  /** Gold support relations, one class per (evidenceId, targetClaimId) pair. */
  goldSupport: { evidenceId: string; targetClaimId: string; support: SupportClass }[]
  predictedSupport: { evidenceId: string; targetClaimId: string; support: SupportClass }[]
}

// ---------------------------------------------------------------------------
// Text and span primitives
// ---------------------------------------------------------------------------

/** NFKC + whitespace-fold normalization (§22.2, frozen). */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

/** Levenshtein distance over code points of the (already normalized) strings. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]!
}

/** Edit similarity in [0,1]: 1 - distance/max(len). Empty↔empty is 1. */
export function editSimilarity(a: string, b: string): number {
  const na = normalizeText(a)
  const nb = normalizeText(b)
  const max = Math.max(na.length, nb.length)
  if (max === 0) return 1
  return 1 - editDistance(na, nb) / max
}

/** IoU of two half-open spans; 0 when the union is empty. */
export function spanIoU(a: readonly [number, number], b: readonly [number, number]): number {
  const inter = Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]))
  const union = Math.max(a[1], b[1]) - Math.min(a[0], b[0])
  return union === 0 ? 0 : inter / union
}

/** IoU ≥0.5 AND kind equal AND normalized-text edit similarity ≥0.8 (§22.2, frozen). */
export function matchAtomicClaim(gold: AtomicClaim, predicted: AtomicClaim): boolean {
  return (
    spanIoU(gold.span, predicted.span) >= 0.5 &&
    gold.kind === predicted.kind &&
    editSimilarity(gold.text, predicted.text) >= 0.8
  )
}

// ---------------------------------------------------------------------------
// Claim-level recall/precision with split/merge credit
// ---------------------------------------------------------------------------

/**
 * Claim metrics over one case. Split/merge (1:N): recall counts a gold
 * claim as a hit when AT LEAST ONE of its matches is predicted (a split
 * prediction still counts as one recall hit); precision counts each
 * predicted claim that matches some gold claim (hits/predictions), so a
 * 1:3 split costs precision two misses.
 */
export function claimMetrics(case_: Pick<CaseIo, 'goldClaims' | 'predictedClaims'>): {
  recallHits: number
  goldCount: number
  precisionHits: number
  predictedCount: number
  recall: number
  precision: number
} {
  let recallHits = 0
  let precisionHits = 0
  for (const g of case_.goldClaims) {
    if (case_.predictedClaims.some((p) => matchAtomicClaim(g, p))) recallHits++
  }
  for (const p of case_.predictedClaims) {
    if (case_.goldClaims.some((g) => matchAtomicClaim(g, p))) precisionHits++
  }
  const recall = case_.goldClaims.length === 0 ? 1 : recallHits / case_.goldClaims.length
  const precision = case_.predictedClaims.length === 0 ? 1 : precisionHits / case_.predictedClaims.length
  return {
    recallHits,
    goldCount: case_.goldClaims.length,
    precisionHits,
    predictedCount: case_.predictedClaims.length,
    recall,
    precision,
  }
}

/** Core recall: hits restricted to gold claims marked core (§22.2 ≥0.95). */
export function coreRecall(case_: Pick<CaseIo, 'goldClaims' | 'predictedClaims'>): {
  hits: number
  coreCount: number
  recall: number
} {
  const core = case_.goldClaims.filter((c) => c.core)
  const hits = core.filter((g) => case_.predictedClaims.some((p) => matchAtomicClaim(g, p))).length
  return { hits, coreCount: core.length, recall: core.length === 0 ? 1 : hits / core.length }
}

// ---------------------------------------------------------------------------
// Major-fault metrics
// ---------------------------------------------------------------------------

const MAJOR: ReadonlySet<string> = new Set(['blocker', 'major'])

/** Major-fault identification recall (§22.2 ≥0.90). */
export function majorFaultRecall(case_: Pick<CaseIo, 'goldFindings' | 'predictedFindings'>): {
  detected: number
  goldMajor: number
  recall: number
} {
  // ponytail: set-of-severities only — fault identity here is the finding id;
  // span-level fault matching, if the calibration round demands it, extends
  // this predicate without touching the callers.
  const predMajor = new Set(case_.predictedFindings.filter((f) => MAJOR.has(f.severity)).map((f) => f.id))
  const goldMajor = case_.goldFindings.filter((f) => MAJOR.has(f.severity))
  const detected = goldMajor.filter((f) => predMajor.has(f.id)).length
  return { detected, goldMajor: goldMajor.length, recall: goldMajor.length === 0 ? 1 : detected / goldMajor.length }
}

/**
 * major/blocker false-positive rate on clean samples (§22.2 ≤0.10).
 * Denominator = number of clean positives, per the frozen spec.
 */
export function cleanFpRate(
  cases: Pick<CaseIo, 'clean' | 'predictedFindings'>[],
): { falsePositives: number; cleanPositives: number; rate: number } {
  const clean = cases.filter((c) => c.clean)
  const fps = clean.filter((c) => c.predictedFindings.some((f) => MAJOR.has(f.severity))).length
  return {
    falsePositives: fps,
    cleanPositives: clean.length,
    rate: clean.length === 0 ? 0 : fps / clean.length,
  }
}

// ---------------------------------------------------------------------------
// Support-relation macro-F1
// ---------------------------------------------------------------------------

/**
 * Support-relation macro-F1 (§22.2 ≥0.85). Evaluation unit: the
 * (evidenceId, targetClaimId) pair; a predicted pair is correct only when
 * the same pair exists in gold with the same class. Per-class F1 is
 * computed over pair counts; macro averages over the classes PRESENT in
 * gold (absent classes excluded, frozen).
 */
export function supportMacroF1(case_: Pick<CaseIo, 'goldSupport' | 'predictedSupport'>): {
  perClass: Record<string, { tp: number; fp: number; fn: number; f1: number }>
  macroF1: number
} {
  const key = (p: { evidenceId: string; targetClaimId: string }) => `${p.evidenceId}\u0000${p.targetClaimId}`
  const goldByPair = new Map(case_.goldSupport.map((p) => [key(p), p.support]))
  const predByPair = new Map(case_.predictedSupport.map((p) => [key(p), p.support]))
  const perClass: Record<string, { tp: number; fp: number; fn: number; f1: number }> = {}
  for (const cls of SUPPORT_CLASSES) perClass[cls] = { tp: 0, fp: 0, fn: 0, f1: 0 }
  for (const [pair, cls] of predByPair) {
    if (goldByPair.get(pair) === cls) perClass[cls]!.tp++
    else perClass[cls]!.fp++
  }
  for (const [pair, cls] of goldByPair) {
    if (predByPair.get(pair) !== cls) perClass[cls]!.fn++
  }
  let sum = 0
  let present = 0
  for (const cls of SUPPORT_CLASSES) {
    const c = perClass[cls]!
    const denom = 2 * c.tp + c.fp + c.fn
    c.f1 = denom === 0 ? 0 : (2 * c.tp) / denom
    // Present in gold = at least one gold pair of this class (absent classes excluded).
    if (c.tp + c.fn > 0) {
      sum += c.f1
      present++
    }
  }
  return { perClass, macroF1: present === 0 ? 1 : sum / present }
}

// ---------------------------------------------------------------------------
// Bootstrap CI (pure PRNG, fixed seed)
// ---------------------------------------------------------------------------

/** mulberry32 — small, deterministic, seedable (pure, no Math.random). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Percentile bootstrap 95% CI over per-case metric values (§22.2, frozen:
 * seed 20261016, 10000 resamples). Disclosed only — never a gate.
 */
export function bootstrapCi(
  values: number[],
  opts?: { seed?: number; resamples?: number },
): { low: number; high: number; mean: number; n: number } {
  const seed = opts?.seed ?? BOOTSTRAP_SEED
  const resamples = opts?.resamples ?? BOOTSTRAP_RESAMPLES
  const n = values.length
  if (n === 0) return { low: 0, high: 0, mean: 0, n: 0 }
  const mean = values.reduce((s, v) => s + v, 0) / n
  if (n === 1 || resamples === 0) return { low: mean, high: mean, mean, n }
  const rand = mulberry32(seed)
  const means: number[] = []
  for (let r = 0; r < resamples; r++) {
    let s = 0
    for (let i = 0; i < n; i++) s += values[Math.floor(rand() * n)]!
    means.push(s / n)
  }
  means.sort((a, b) => a - b)
  const q = (p: number) => means[Math.min(means.length - 1, Math.floor(p * means.length))]!
  return { low: q(0.025), high: q(0.975), mean, n }
}
