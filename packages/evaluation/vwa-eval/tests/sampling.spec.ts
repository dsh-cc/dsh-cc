import { describe, expect, it } from 'vitest'
import { BUDGET, K_ATOMIC_FACTS, SAMPLING_LABELS, f1AtK, pickRows, sampleCount } from '../src/sampling.js'
import { detectorRecall, exportGoldSentences, mergeAnnotations, splitSentences } from '../src/annotation.js'

describe('sampling math', () => {
  it('dogfood: ceil(20%) with min 5; post-acceptance: ceil(5%)', () => {
    expect(sampleCount(0, 'dogfood')).toBe(5)
    expect(sampleCount(10, 'dogfood')).toBe(5)
    expect(sampleCount(20, 'dogfood')).toBe(5)
    expect(sampleCount(21, 'dogfood')).toBe(5) // ceil(4.2)=5
    expect(sampleCount(30, 'dogfood')).toBe(6)
    expect(sampleCount(100, 'dogfood')).toBe(20)
    expect(sampleCount(0, 'post-acceptance')).toBe(1)
    expect(sampleCount(19, 'post-acceptance')).toBe(1)
    expect(sampleCount(20, 'post-acceptance')).toBe(1)
    expect(sampleCount(40, 'post-acceptance')).toBe(2)
  })

  it('pins the budget table and K constant', () => {
    expect(BUDGET.judgeCallsPerBatch).toBe(40)
    expect(BUDGET.tokensPerBatch).toBe(200_000)
    expect(K_ATOMIC_FACTS).toBe(20)
    expect(SAMPLING_LABELS).toEqual(['supported', 'partially', 'unsupported', 'irrelevant'])
  })

  it('F1@K on a hand case', () => {
    // 20 facts: 12 supported, 3 partially, 5 unsupported → good=15.
    const labels: Array<'supported' | 'partially' | 'unsupported' | 'irrelevant'> = [
      ...Array(12).fill('supported'),
      ...Array(3).fill('partially'),
      ...Array(5).fill('unsupported'),
    ]
    // precision = 15/20 = 0.75; recall = 15/20 = 0.75; F1 = 0.75.
    expect(f1AtK(labels)).toEqual({ precision: 0.75, recall: 0.75, f1: 0.75 })
    // Fewer than K facts: precision over what exists, recall penalized.
    expect(f1AtK(['supported'])).toEqual({ precision: 1, recall: 1 / 20, f1: (2 * 1 * (1 / 20)) / (1 + 1 / 20) })
    expect(f1AtK([]).f1).toBe(0)
  })

  it('stride pick is deterministic and honors the sample count', () => {
    const rows = Array.from({ length: 30 }, (_, i) => i)
    const picked = pickRows(rows, 'dogfood')
    expect(picked).toHaveLength(6)
    expect(pickRows(rows, 'dogfood')).toEqual(picked)
    expect(picked.every((r) => rows.includes(r))).toBe(true)
    expect(pickRows([], 'post-acceptance')).toEqual([])
  })
})

describe('sentence export', () => {
  it('splits on §4.2 boundaries, keeps decimal dots, flags detector hits', () => {
    const doc = 'v1.2 ships 3 days faster. Released 2026-01-02\nSecond line with extractClaims() calls.'
    const sentences = splitSentences('x.md', doc)
    // 'v1.2 ships 3 days faster.' stays one sentence (decimal dot).
    expect(sentences[0].text).toBe('v1.2 ships 3 days faster.')
    expect(sentences[0].detected).toBe(true)
    expect(sentences.length).toBe(3)
    expect(sentences.map((s) => s.index)).toEqual([0, 1, 2])
  })

  it('exports sentences for the pinned gold set with a detected flag', async () => {
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
    const root = join(pkg, '..', '..', '..')
    const sentences = exportGoldSentences(pkg, root)
    expect(sentences.length).toBeGreaterThan(500)
    for (const s of sentences) expect(typeof s.detected).toBe('boolean')
  })
})

describe('annotation merge and recall', () => {
  const doc = 'Rate is 90%. Done.'
  const sentences = splitSentences('d.md', doc)
  const a = [{ path: 'd.md', index: 0, predicate: 'verifiable' as const }, { path: 'd.md', index: 1, predicate: 'not' as const }]
  const b = [{ path: 'd.md', index: 0, predicate: 'verifiable' as const }, { path: 'd.md', index: 1, predicate: 'not' as const }]

  it('passes agreeing rows, drops disagreements pending adjudication', () => {
    const merged = mergeAnnotations(a, b, [])
    expect(merged.entries).toHaveLength(2)
    const bDisagree = [b[0], { ...b[1], predicate: 'verifiable' as const }]
    const disagree = mergeAnnotations(a, bDisagree, [])
    expect(disagree.entries).toHaveLength(1) // only the agreement survives
  })

  it('throws when an annotator row is missing', () => {
    expect(() => mergeAnnotations(a, [b[0]], [])).toThrow(/without a B row/)
    expect(() => mergeAnnotations(a, b, [{ path: 'zz.md', index: 0, predicate: 'verifiable' }])).toThrow(/annotator rows/)
  })

  it('adjudication wins', () => {
    const merged = mergeAnnotations(a, b, [{ path: 'd.md', index: 1, predicate: 'verifiable', adjudicator: 'user' }])
    expect(merged.entries.find((e) => e.index === 1)?.predicate).toBe('verifiable')
  })

  it('detector recall counts detected fraction of human-verifiable sentences', () => {
    const ann = [{ path: 'd.md', index: 0, predicate: 'verifiable' as const }]
    expect(detectorRecall(sentences, ann)).toEqual({ humanVerifiable: 1, detected: 1, recall: 1 })
    // Sentence 1 ('Done.') is not detector-flagged; claiming it verifiable halves recall.
    const ann2 = [...ann, { path: 'd.md', index: 1, predicate: 'verifiable' as const }]
    const stats = detectorRecall(sentences, ann2)
    expect(stats.humanVerifiable).toBe(2)
    expect(stats.detected).toBe(1)
    expect(stats.recall).toBe(0.5)
  })
})
