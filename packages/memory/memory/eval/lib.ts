/**
 * Pure validation + metric helpers for the W4 recall-selection quality eval
 * harness. Imported only by the vitest specs in ../tests/eval-*.spec.ts —
 * not part of the shipped package surface.
 * @module
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** One golden query with its expected (required) and acceptable (tolerated) files. */
export interface GoldenQuery {
  query: string
  required: string[]
  tolerated: string[]
}

/** A declared distractor cluster: members lookalike, only `relevant` are wanted. */
export interface DistractorCluster {
  id: string
  members: string[]
  relevant: string[]
}

export interface GoldenFile {
  queries: GoldenQuery[]
  clusters: DistractorCluster[]
}

/** Precision/recall/F1 over the required set for one query/selection pair. */
export interface QueryScore {
  precision: number
  recall: number
  f1: number
}

/**
 * Per-query score. Tolerated extras never hurt precision; anything outside
 * required ∪ tolerated is a false positive. Empty-required queries (the
 * no-relevant class) score recall 1 trivially and are precision-punished for
 * any leak, so a perfect empty selection scores 1/1/1.
 */
export function perQueryScore(selected: readonly string[], required: readonly string[], tolerated: readonly string[]): { precision: number; recall: number; f1: number } {
  const chosen = new Set(selected)
  const relevant = new Set(required)
  const acceptable = new Set([...required, ...tolerated])
  let hits = 0
  let extras = 0
  for (const name of chosen) {
    if (relevant.has(name)) hits++
    else if (!acceptable.has(name)) extras++
  }
  // Vacuous precision is 1 only when nothing was required (empty-selection
  // correctness); an empty selection against non-empty required scores 0.
  const precision = hits + extras === 0 ? (required.length === 0 ? 1 : 0) : hits / (hits + extras)
  const recall = required.length === 0 ? 1 : hits / required.length
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return { precision, recall, f1 }
}

/** Macro-average of per-query scores; empty input yields zeros. */
export function macroAverage(scores: readonly { precision: number; recall: number; f1: number }[]): { precision: number; recall: number; f1: number } {
  if (scores.length === 0) return { precision: 0, recall: 0, f1: 0 }
  const sum = scores.reduce((acc, s) => ({ precision: acc.precision + s.precision, recall: acc.recall + s.recall, f1: acc.f1 + s.f1 }), { precision: 0, recall: 0, f1: 0 })
  return { precision: sum.precision / scores.length, recall: sum.recall / scores.length, f1: sum.f1 / scores.length }
}

/** Paired per-query agreement between two arms: Jaccard over selections (1 for both-empty). */
export function jaccardAgreement(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size === 0 && sb.size === 0) return 1
  let inter = 0
  for (const name of sa) if (sb.has(name)) inter++
  const union = sa.size + sb.size - inter
  return union === 0 ? 1 : inter / union
}

/** All topic filenames under a fixture dir (excluding the MEMORY.md index). */
export function fixtureFilenames(dir: string): string[] {
  return readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md').sort()
}

/**
 * Validate the fixture tree. Returns a list of problems (empty = valid).
 * Checks: 25-30 topic files, every fixture has a non-empty description line
 * in MEMORY.md, and golden.json declares ≥3 distractor clusters
 * (relevant ⊊ members, 3-5 members).
 * @param dir - the fixture-memory directory.
 * @param injectedIndex - test seam: per-dir MEMORY.md overrides.
 */
export function validateFixtures(dir: string, injectedIndex?: Map<string, string>): string[] {
  const problems: string[] = []
  const files = fixtureFilenames(dir)
  if (files.length < 25 || files.length > 30) {
    problems.push(`fixture count ${files.length} outside [25, 30]`)
  }
  const indexText = injectedIndex?.get('MEMORY.md') ?? readFileSync(join(dir, 'MEMORY.md'), 'utf8')
  for (const file of files) {
    const line = indexText
      .split('\n')
      .find(l => l.includes(file))
    if (line === undefined) {
      problems.push(`${file} missing from MEMORY.md index`)
    } else if (line.replace(/[-*\s]|\.md/g, '').trim().length === 0) {
      problems.push(`${file} has an empty description line in MEMORY.md`)
    }
  }
  const goldenPath = join(dir, '..', 'golden.json')
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as GoldenFile
  const distractorClusters = golden.clusters.filter(
    cluster =>
      cluster.members.length >= 3
      && cluster.members.length <= 5
      && cluster.relevant.length > 0
      && cluster.relevant.length < cluster.members.length,
  )
  if (distractorClusters.length < 3) {
    problems.push(`only ${distractorClusters.length} distractor clusters declared (need ≥3)`)
  }
  return problems
}

/**
 * Validate the golden file: exactly 10 queries per class across the 4 classes,
 * required/tolerated ⊆ fixture files, and no-relevant queries with empty required.
 */
export function validateGolden(golden: unknown, fixtureFiles: readonly string[]): string[] {
  const problems: string[] = []
  const { queries } = golden as GoldenFile
  const files = new Set(fixtureFiles)
  const CLASSES = ['direct-topic', 'compositional', 'no-relevant-memory', 'ambiguous-phrasing'] as const
  for (const cls of CLASSES) {
    const count = queries.filter(q => (q as { class?: string }).class === cls).length
    if (count !== 10) problems.push(`class ${cls}: expected 10 queries, found ${count}`)
  }
  if (!CLASSES.some(cls => queries.some(q => (q as { class?: string }).class === cls))) {
    problems.push('no query carries a recognized class field')
  }
  for (const q of queries as Array<{ query: string; required: string[]; tolerated: string[]; class: string }>) {
    for (const name of q.required) if (!files.has(name)) problems.push(`query "${q.query}": required references unknown fixture ${name}`)
    for (const name of q.tolerated) if (!files.has(name)) problems.push(`query "${q.query}": tolerated references unknown fixture ${name}`)
    if (q.class === 'no-relevant-memory' && q.required.length > 0) {
      problems.push(`no-relevant query "${q.query}" must have empty required`)
    }
    if (q.class !== 'no-relevant-memory' && q.required.length === 0) {
      problems.push(`query "${q.query}" (${q.class}) must have non-empty required`)
    }
  }
  return problems
}
