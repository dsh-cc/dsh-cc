import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BOOTSTRAP_SEED,
  LANE1_SUPPORT_MAP,
  SCORER_VERSION,
  bootstrapCi,
  claimMetrics,
  cleanFpRate,
  coreRecall,
  editSimilarity,
  majorFaultRecall,
  matchAtomicClaim,
  mulberry32,
  normalizeText,
  spanIoU,
  supportMacroF1,
  type AtomicClaim,
} from '../src/scorer.js'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = join(pkg, '..', '..', '..')

const claim = (id: string, span: [number, number], kind: string, text: string, core = false): AtomicClaim => ({
  id,
  span,
  kind,
  text,
  ...(core ? { core } : {}),
})

describe('humanities-scorer@1 primitives (§22.2)', () => {
  it('pins the frozen scorer version, seed, and lane-1 mapping', () => {
    expect(SCORER_VERSION).toBe('humanities-scorer@1')
    expect(BOOTSTRAP_SEED).toBe(20261016)
    expect(LANE1_SUPPORT_MAP).toEqual({
      supported: 'direct',
      partially: 'partial',
      unsupported: 'contradicted',
      irrelevant: 'irrelevant',
    })
  })

  it('normalizes with NFKC + whitespace folding', () => {
    expect(normalizeText('ＡＢ\u00a0 C')).toBe('AB C')
    expect(normalizeText('a\n\t b')).toBe('a b')
  })

  it('computes edit similarity with the 0.8 threshold', () => {
    expect(editSimilarity('abc', 'abc')).toBe(1)
    expect(editSimilarity('', '')).toBe(1)
    // 1 changed char out of 5 → 0.8: exactly at the frozen threshold, still a match.
    expect(editSimilarity('abcde', 'abcdf')).toBe(0.8)
    expect(editSimilarity('abcde', 'xyzde')).toBeLessThan(0.8)
  })

  it('computes span IoU including the empty-union case', () => {
    expect(spanIoU([0, 10], [0, 10])).toBe(1)
    expect(spanIoU([0, 10], [5, 15])).toBeCloseTo(5 / 15)
    expect(spanIoU([0, 5], [10, 15])).toBe(0)
  })

  it('matches atomic claims only when IoU AND kind AND similarity all hold', () => {
    const gold = claim('g1', [0, 10], 'factual', 'abcde fghij')
    expect(matchAtomicClaim(gold, claim('p1', [2, 12], 'factual', 'abcde fghij'))).toBe(true)
    // IoU below 0.5.
    expect(matchAtomicClaim(gold, claim('p2', [8, 18], 'factual', 'abcde fghij'))).toBe(false)
    // Kind differs.
    expect(matchAtomicClaim(gold, claim('p3', [0, 10], 'interpretive', 'abcde fghij'))).toBe(false)
    // Text differs beyond 0.8 similarity.
    expect(matchAtomicClaim(gold, claim('p4', [0, 10], 'factual', 'zzzzz yyyyy'))).toBe(false)
  })
})

describe('claim metrics with split/merge credit (§22.2)', () => {
  const gold = claim('g1', [0, 17], 'factual', 'aaaaa bbbbb ccccc', true)

  it('1:N split — recall one hit, precision hits/predictions', () => {
    const preds = [claim('p1', [0, 10], 'factual', 'aaaaa bbbbb ccccc'), claim('p2', [11, 17], 'factual', 'bbbbb')]
    const m = claimMetrics({ goldClaims: [gold], predictedClaims: preds })
    expect(m.recallHits).toBe(1)
    expect(m.goldCount).toBe(1)
    expect(m.precisionHits).toBe(1)
    expect(m.predictedCount).toBe(2)
    expect(m.recall).toBe(1)
    expect(m.precision).toBe(0.5)
  })

  it('N:1 merge — each gold claim with ≥1 matching prediction counts', () => {
    const golds = [claim('g1', [0, 10], 'factual', 'aaaaa bbbbb'), claim('g2', [0, 10], 'factual', 'aaaaa bbbbb ')]
    const m = claimMetrics({ goldClaims: golds, predictedClaims: [claim('p1', [0, 10], 'factual', 'aaaaa bbbbb')] })
    expect(m.recallHits).toBe(2)
    expect(m.recall).toBe(1)
    expect(m.precision).toBe(1)
  })

  it('a non-matching prediction costs precision only', () => {
    const m = claimMetrics({ goldClaims: [gold], predictedClaims: [claim('p9', [20, 30], 'factual', 'zzzzz')] })
    expect(m.recall).toBe(0)
    expect(m.precision).toBe(0)
  })

  it('empty prediction set → recall 0, precision 1 by convention; empty gold → recall 1', () => {
    expect(claimMetrics({ goldClaims: [gold], predictedClaims: [] }).precision).toBe(1)
    expect(claimMetrics({ goldClaims: [], predictedClaims: [claim('p1', [0, 1], 'k', 't')] }).recall).toBe(1)
  })

  it('core recall counts only core gold claims', () => {
    const r = coreRecall({
      goldClaims: [gold, claim('g2', [30, 40], 'factual', 'noncore')],
      predictedClaims: [claim('p1', [0, 17], 'factual', 'aaaaa bbbbb ccccc')],
    })
    expect(r).toEqual({ hits: 1, coreCount: 1, recall: 1 })
  })
})

describe('major-fault and clean-sample metrics (§22.2)', () => {
  it('major fault recall: severity ∈ {blocker, major}, minors never count', () => {
    const r = majorFaultRecall({
      goldFindings: [
        { id: 'f1', severity: 'blocker' },
        { id: 'f2', severity: 'major' },
        { id: 'f3', severity: 'minor' },
      ],
      predictedFindings: [{ id: 'f1', severity: 'major' }],
    })
    expect(r).toEqual({ detected: 1, goldMajor: 2, recall: 0.5 })
  })

  it('no gold major faults → recall 1 by convention', () => {
    expect(majorFaultRecall({ goldFindings: [], predictedFindings: [{ id: 'x', severity: 'major' }] }).recall).toBe(1)
  })

  it('clean FP rate denominator is the number of clean positives', () => {
    const cases = [
      { clean: true, predictedFindings: [{ id: 'fp1', severity: 'major' as const }] },
      { clean: true, predictedFindings: [] },
      { clean: false, predictedFindings: [{ id: 'ignored', severity: 'blocker' as const }] },
    ]
    const r = cleanFpRate(cases)
    expect(r).toEqual({ falsePositives: 1, cleanPositives: 2, rate: 0.5 })
  })
})

describe('support-relation macro-F1 (§22.2)', () => {
  it('pairs are the unit; absent classes are excluded from the macro average', () => {
    const r = supportMacroF1({
      goldSupport: [
        { evidenceId: 'ev-1', targetClaimId: 'claim-1', support: 'direct' },
        { evidenceId: 'ev-2', targetClaimId: 'claim-2', support: 'contradicted' },
      ],
      predictedSupport: [
        { evidenceId: 'ev-1', targetClaimId: 'claim-1', support: 'direct' },
        { evidenceId: 'ev-2', targetClaimId: 'claim-2', support: 'partial' },
        // Extra predicted pair with a gold-absent class (irrelevant) — counted as fp.
        { evidenceId: 'ev-3', targetClaimId: 'claim-3', support: 'irrelevant' },
      ],
    })
    expect(r.perClass.direct).toEqual({ tp: 1, fp: 0, fn: 0, f1: 1 })
    expect(r.perClass.contradicted).toEqual({ tp: 0, fp: 0, fn: 1, f1: 0 })
    expect(r.perClass.irrelevant!.tp).toBe(0)
    expect(r.perClass.irrelevant!.fp).toBe(1)
    // Present classes: direct (1) and contradicted (0); irrelevant (gold-absent) excluded.
    expect(r.macroF1).toBe(0.5)
  })

  it('no gold pairs → macroF1 1 by convention', () => {
    expect(supportMacroF1({ goldSupport: [], predictedSupport: [] }).macroF1).toBe(1)
  })
})

describe('bootstrap CI (fixed seed, pure PRNG)', () => {
  it('mulberry32 is deterministic for a fixed seed', () => {
    const a = mulberry32(BOOTSTRAP_SEED)
    const b = mulberry32(BOOTSTRAP_SEED)
    const seqA = Array.from({ length: 5 }, () => a())
    expect(seqA).toEqual(Array.from({ length: 5 }, () => b()))
    expect(new Set(seqA).size).toBe(5)
  })

  it('bootstrapCi is reproducible and brackets the mean', () => {
    const values = [1, 0, 1, 1, 0, 1, 1, 1, 0, 1]
    const ci1 = bootstrapCi(values)
    const ci2 = bootstrapCi([...values])
    expect(ci2).toEqual(ci1)
    expect(ci1.low <= ci1.mean && ci1.mean <= ci1.high).toBe(true)
    expect(ci1.n).toBe(values.length)
  })

  it('degenerate inputs: empty → zeros, single value → point', () => {
    expect(bootstrapCi([])).toEqual({ low: 0, high: 0, mean: 0, n: 0 })
    expect(bootstrapCi([0.7])).toEqual({ low: 0.7, high: 0.7, mean: 0.7, n: 1 })
  })
})

describe('humanities gold pipeline (synthetic cases only)', () => {
  it('the committed manifest round-trips through the builder --check and stays synthetic-marked', () => {
    const out = execFileSync('node', [join(pkg, 'scripts', 'build-humanities-manifest.mjs'), '--check'], { cwd: root })
    expect(out.toString()).toContain('check OK: 3 cases (2 dev / 1 holdout)')
    const manifest = JSON.parse(readFileSync(join(pkg, 'humanities', 'gold-manifest.json'), 'utf8'))
    expect(manifest.schema).toBe('vwa-eval/humanities-gold-manifest@1')
    expect(manifest.scorer).toBe('humanities-scorer@1')
    expect(manifest.cases.every((c: { synthetic: boolean }) => c.synthetic === true)).toBe(true)
    expect(manifest.cases.every((c: { sha256: string }) => /^[0-9a-f]{64}$/.test(c.sha256))).toBe(true)
    expect(manifest.cases.every((c: { clean: boolean; split: string }) => typeof c.clean === 'boolean' && ['dev', 'holdout'].includes(c.split))).toBe(true)
  })
})
