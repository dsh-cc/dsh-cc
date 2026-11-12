/**
 * Specs for the pre-registered metric math of the tool-discovery activation
 * eval (`docs/plans/2026-11-12-tool-discovery-activation.md`,
 * `scripts/lib/eval-metrics.mjs`).
 *
 * Pinned here:
 *  - micro-F1 over (query, candidate) pairs, including the zero-denominator
 *    semantics that exempt the negative-only class from the F1 floor.
 *  - exact-set accuracy, order-insensitive, null on an empty corpus.
 *  - false-activation rate as an aggregate count ratio, null without
 *    candidates.
 *  - nearest-rank percentiles.
 *  - the one-sided Wilson lower bound, including the clamped extremes and one
 *    hand-computed value.
 *  - the 2/3 tune / 1/3 held-out split: deterministic, lossless, pure.
 *
 * All labels below are synthetic placeholders: the metric layer never sees a
 * real query or candidate name.
 */

import { describe, expect, it } from 'vitest'
import {
  exactSetAccuracy,
  falseActivationRate,
  microF1,
  percentiles,
  splitCorpus,
  wilsonLowerBound,
} from '../scripts/lib/eval-metrics.mjs'

/** Terse pair builder: `p(gold, predicted)`. */
const pair = (gold: boolean, predicted: boolean) => ({ gold, predicted })

describe('microF1', () => {
  it('scores a perfect slice as 1 with no errors', () => {
    const result = microF1([pair(true, true), pair(true, true), pair(true, true)])
    expect(result).toEqual({ f1: 1, precision: 1, recall: 1, tp: 3, fp: 0, fn: 0 })
  })

  it('reports mixed tp/fp/fn with hand-computed precision, recall and F1', () => {
    // tp = 3, fp = 1, fn = 2 -> P = 3/4 = 0.75, R = 3/5 = 0.6,
    // F1 = 2*0.75*0.6 / (0.75 + 0.6) = 0.9 / 1.35 = 2/3.
    const result = microF1([
      pair(true, true),
      pair(true, true),
      pair(true, true),
      pair(false, true),
      pair(true, false),
      pair(true, false),
      pair(false, false),
      pair(false, false),
    ])
    expect(result).toMatchObject({ tp: 3, fp: 1, fn: 2 })
    expect(result.precision).toBeCloseTo(0.75, 10)
    expect(result.recall).toBeCloseTo(0.6, 10)
    expect(result.f1).toBeCloseTo(2 / 3, 10)
  })

  it('leaves F1 undefined for an all-negative slice (zero denominator, not 0)', () => {
    const result = microF1([pair(false, false), pair(false, false), pair(false, false)])
    expect(result).toEqual({ f1: null, precision: null, recall: null, tp: 0, fp: 0, fn: 0 })
  })

  it('leaves F1 undefined when every prediction is wrong', () => {
    const result = microF1([pair(true, false), pair(false, true)])
    expect(result).toEqual({ f1: null, precision: 0, recall: 0, tp: 0, fp: 1, fn: 1 })
  })

  it('leaves F1 undefined for an empty pair list', () => {
    expect(microF1([])).toEqual({ f1: null, precision: null, recall: null, tp: 0, fp: 0, fn: 0 })
  })

  it('reports recall null but precision defined when positives are missed and something is predicted', () => {
    const result = microF1([pair(true, false), pair(false, false)])
    expect(result).toMatchObject({ f1: null, precision: null, recall: 0, tp: 0, fp: 0, fn: 1 })
  })
})

describe('exactSetAccuracy', () => {
  it('is 1.0 when every predicted set equals its gold set', () => {
    expect(exactSetAccuracy([
      { predicted: ['c1'], gold: ['c1'] },
      { predicted: ['c2', 'c3'], gold: ['c2', 'c3'] },
    ])).toBe(1)
  })

  it('is 0.5 when one of two items diverges', () => {
    expect(exactSetAccuracy([
      { predicted: ['c1'], gold: ['c1'] },
      { predicted: ['c2'], gold: ['c1'] },
    ])).toBe(0.5)
  })

  it('ignores order and duplicates', () => {
    expect(exactSetAccuracy([{ predicted: ['c2', 'c1'], gold: ['c1', 'c2'] }])).toBe(1)
    expect(exactSetAccuracy([{ predicted: ['c1', 'c1'], gold: ['c1'] }])).toBe(1)
  })

  it('counts a superset or subset as inexact', () => {
    expect(exactSetAccuracy([{ predicted: ['c1', 'c2'], gold: ['c1'] }])).toBe(0)
    expect(exactSetAccuracy([{ predicted: [], gold: ['c1'] }])).toBe(0)
  })

  it('is null for an empty corpus', () => {
    expect(exactSetAccuracy([])).toBeNull()
  })
})

describe('falseActivationRate', () => {
  it('aggregates counts across cases', () => {
    expect(falseActivationRate([1, 2, 0], [10, 20, 30])).toEqual({ rate: 0.05, activated: 3, candidates: 60 })
  })

  it('is null when the candidate total is zero', () => {
    expect(falseActivationRate([0, 0], [0, 0])).toEqual({ rate: null, activated: 0, candidates: 0 })
  })

  it('is null for empty inputs', () => {
    expect(falseActivationRate([], [])).toEqual({ rate: null, activated: 0, candidates: 0 })
  })

  it('can reach 1.0 when every candidate activates', () => {
    expect(falseActivationRate([5, 5], [5, 5])).toEqual({ rate: 1, activated: 10, candidates: 10 })
  })
})

describe('percentiles', () => {
  it('uses nearest rank on 1..10', () => {
    expect(percentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({ p50: 5, p90: 9, max: 10 })
  })

  it('sorts its input before ranking', () => {
    expect(percentiles([10, 1, 5, 3, 2, 4, 9, 8, 7, 6])).toEqual({ p50: 5, p90: 9, max: 10 })
  })

  it('returns the single element for every field', () => {
    expect(percentiles([7])).toEqual({ p50: 7, p90: 7, max: 7 })
  })

  it('is all null for an empty sample', () => {
    expect(percentiles([])).toEqual({ p50: null, p90: null, max: null })
  })

  it('does not mutate its input', () => {
    const values = [3, 1, 2]
    percentiles(values)
    expect(values).toEqual([3, 1, 2])
  })
})

describe('wilsonLowerBound', () => {
  it('returns a bound below 1 when every observation succeeds', () => {
    // 1 / (1 + z^2/n) with z = 1.645, n = 30.
    const bound = wilsonLowerBound(30, 30)
    expect(bound).toBeCloseTo(0.9173, 4)
    expect(bound).toBeLessThan(1)
    expect(bound).toBeGreaterThan(0)
  })

  it('clamps a zero-success bound at 0', () => {
    const bound = wilsonLowerBound(0, 30)
    expect(bound).toBeGreaterThanOrEqual(0)
    expect(bound).toBeCloseTo(0, 10)
  })

  it('is null without observations', () => {
    expect(wilsonLowerBound(0, 0)).toBeNull()
  })

  it('matches the hand-computed one-sided bound for 21/30', () => {
    // z = 1.645, p-hat = 0.7, n = 30:
    //   (0.7 + z^2/60 - z*sqrt(0.21/30 + z^2/3600)) / (1 + z^2/30)
    //   = (0.7 + 0.0451004 - 1.645 * 0.0880436) / 1.0902008 = 0.550604
    expect(wilsonLowerBound(21, 30, 1.645)).toBeCloseTo(0.5506, 2)
  })

  it('defaults z to 1.645', () => {
    expect(wilsonLowerBound(21, 30)).toBe(wilsonLowerBound(21, 30, 1.645))
  })

  it('sharpens as the sample grows at a fixed rate', () => {
    // NaN (from a null bound) fails every ordering assertion, so this cannot
    // pass vacuously.
    const bound = (successes: number, total: number) => wilsonLowerBound(successes, total) ?? Number.NaN
    expect(bound(42, 60)).toBeGreaterThan(bound(21, 30))
    expect(bound(21, 30)).toBeGreaterThan(bound(7, 10))
  })
})

describe('splitCorpus', () => {
  /** A corpus of n synthetic cases; ids are opaque, disjoint from real data. */
  const corpus = (n: number) =>
    Array.from({ length: n }, (_, index) => ({ id: `case-${index}`, payload: index }))

  it('is deterministic across calls', () => {
    const cases = corpus(60)
    expect(splitCorpus(cases)).toEqual(splitCorpus(cases))
  })

  it('partitions the input with no loss or duplication', () => {
    const cases = corpus(60)
    const { tune, heldOut } = splitCorpus(cases)
    expect(tune.length + heldOut.length).toBe(cases.length)
    expect(new Set([...tune, ...heldOut])).toEqual(new Set(cases))
    const ids = [...tune, ...heldOut].map((item) => item.id)
    expect(new Set(ids).size).toBe(cases.length)
  })

  it('splits 60 cases into 40 tune and 20 held-out', () => {
    const { tune, heldOut } = splitCorpus(corpus(60))
    expect(tune.length).toBe(40)
    expect(heldOut.length).toBe(20)
  })

  it('keeps the tune share near two thirds for a large corpus', () => {
    const cases = corpus(300)
    const { tune } = splitCorpus(cases)
    expect(tune.length / cases.length).toBeGreaterThan(0.65)
    expect(tune.length / cases.length).toBeLessThan(0.68)
  })

  it('does not mutate the input array or its members', () => {
    const cases = corpus(10)
    const snapshot = structuredClone(cases)
    splitCorpus(cases)
    expect(cases).toEqual(snapshot)
  })

  it('keeps one tune case for a single-case corpus', () => {
    const { tune, heldOut } = splitCorpus(corpus(1))
    expect(tune).toHaveLength(1)
    expect(heldOut).toHaveLength(0)
  })

  it('keeps at least one tune case for a tiny corpus under a small fraction', () => {
    const { tune } = splitCorpus(corpus(3), { tuneFraction: 0.1 })
    expect(tune).toHaveLength(1)
  })

  it('respects the tuneFraction option', () => {
    const { tune, heldOut } = splitCorpus(corpus(60), { tuneFraction: 0.5 })
    expect(tune).toHaveLength(30)
    expect(heldOut).toHaveLength(30)
  })

  it('returns two empty splits for an empty corpus', () => {
    expect(splitCorpus([])).toEqual({ tune: [], heldOut: [] })
  })
})
