/**
 * Gold-set sentence export, dual-annotation merge, and detector recall
 * (VWA plan docs/plans/2026-10-12-verifiable-workspace-agent.md §8:
 * annotation unit = sentence; protocol = dual annotation with user
 * adjudication; detector recall measured so a silent under-detector cannot
 * inflate coverage).
 *
 * Detection reuses @dsh-cc/vwa-evidence's extractClaims — the frozen
 * four-family detector is NOT reimplemented here. Sentence splitting uses
 * the same proseMask + boundary convention (newline and .!?。！？, decimal
 * dots and marker interiors are not boundaries); the marker-span guard is
 * approximated with the exported findMarkers.
 *
 * @module @dsh-cc/vwa-eval/annotation
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractClaims, findMarkers, proseMask } from '@dsh-cc/vwa-evidence'

/** Sentence-boundary characters (§4.2, frozen). */
const SENTENCE_BOUNDARY = /[.!?\u{3002}\u{FF01}\u{FF1F}\n]/u

export interface ExportedSentence {
  /** Gold-set entry the sentence comes from. */
  path: string
  /** Zero-based sentence index within the document (stable key). */
  index: number
  text: string
  /** True when the frozen detector flags this sentence as a claim candidate. */
  detected: boolean
}

export interface AnnotationEntry {
  path: string
  index: number
  /** 'verifiable' | 'not' */
  predicate: 'verifiable' | 'not'
  detail?: string
}

export interface GoldAnnotations {
  schema: 'vwa-eval/gold-annotations@1'
  adjudicator?: string
  entries: AnnotationEntry[]
}

/** Load the gold set as {path, sha256, bytes} rows. */
export function loadGoldSet(pkgRoot: string): { path: string; sha256: string; bytes: number }[] {
  return JSON.parse(readFileSync(join(pkgRoot, 'gold-set.json'), 'utf8'))
}

/**
 * Split a document into sentences using the vwa-evidence convention and
 * flag detector hits. Mirrors extractClaims's boundary loop (marker
 * interiors and decimal dots are not boundaries) but emits EVERY sentence,
 * detected or not — annotators must see the negatives too.
 */
export function splitSentences(path: string, text: string): ExportedSentence[] {
  const masked = proseMask(text)
  const markers = findMarkers(masked)
  const out: ExportedSentence[] = []
  let start = 0
  let index = 0
  for (let i = 0; i <= masked.length; i++) {
    const atEnd = i === masked.length
    const ch = masked[i] ?? ''
    const insideMarker = markers.some((m) => i > m.span[0] && i < m.span[1])
    const decimalDot = ch === '.' && /\d/.test(masked[i - 1] ?? '') && /\d/.test(masked[i + 1] ?? '')
    if (!atEnd && (!SENTENCE_BOUNDARY.test(ch) || insideMarker || decimalDot)) continue
    const end = atEnd ? i : i + 1
    if (masked.slice(start, end).trim().length > 0) {
      out.push({
        path,
        index: index++,
        text: text.slice(start, end).trim(),
        detected: extractClaims(text.slice(start, end)).claims.length > 0,
      })
    }
    start = i + 1
  }
  return out
}

/** Path of a gold document's pinned snapshot (fixtures/gold/<repo path>). */
export function goldSnapshotPath(pkgRoot: string, path: string): string {
  return join(pkgRoot, 'fixtures', 'gold', path)
}

/**
 * Export every gold-set sentence, for human annotation. Reads the pinned
 * fixtures/gold snapshot, never the live repo file, so annotations stay
 * aligned with the exact bytes that were pinned. `_repoRoot` is kept for
 * call-site compatibility.
 */
export function exportGoldSentences(pkgRoot: string, _repoRoot?: string): ExportedSentence[] {
  return loadGoldSet(pkgRoot).flatMap((entry) =>
    splitSentences(entry.path, readFileSync(goldSnapshotPath(pkgRoot, entry.path), 'utf8')),
  )
}

/**
 * Merge two independent annotation files (annotator A/B) with a third
 * adjudication file into the committed gold annotations. Adjudication
 * wins on conflict; both annotators must have covered the sentence.
 */
export function mergeAnnotations(
  a: AnnotationEntry[],
  b: AnnotationEntry[],
  adjudication: (AnnotationEntry & { adjudicator?: string })[],
): GoldAnnotations {
  const key = (e: AnnotationEntry) => `${e.path}#${e.index}`
  const aMap = new Map(a.map((e) => [key(e), e]))
  const bMap = new Map(b.map((e) => [key(e), e]))
  const out: AnnotationEntry[] = []
  const seen = new Set<string>()
  for (const ad of adjudication) {
    const k = key(ad)
    if (!aMap.has(k) || !bMap.has(k)) {
      throw new Error(`adjudicated entry lacks one or both annotator rows: ${k}`)
    }
    seen.add(k)
    const row: AnnotationEntry = { path: ad.path, index: ad.index, predicate: ad.predicate }
    if (ad.detail !== undefined) row.detail = ad.detail
    out.push(row)
  }
  // Unadjudicated: keep only where A and B AGREE (disagreements must be
  // adjudicated by the user, per the protocol — never auto-resolved).
  for (const [k, ea] of aMap) {
    if (seen.has(k)) continue
    const eb = bMap.get(k)
    if (!eb) throw new Error(`annotator A row without a B row: ${k}`)
    if (ea.predicate === eb.predicate) {
      const row: AnnotationEntry = { path: ea.path, index: ea.index, predicate: ea.predicate }
      if (ea.detail !== undefined) row.detail = ea.detail
      out.push(row)
    }
  }
  out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : x.index - y.index))
  const merged: GoldAnnotations = { schema: 'vwa-eval/gold-annotations@1', entries: out }
  const adjudicator = adjudication[0]?.adjudicator
  if (adjudicator !== undefined) merged.adjudicator = adjudicator
  return merged
}

/**
 * Detector recall: of the sentences humans annotated 'verifiable', the
 * fraction the frozen detector flagged. Computed against the MERGED gold
 * annotations; a low recall means the detector under-detects and coverage
 * must not be trusted (§8).
 */
export function detectorRecall(sentences: ExportedSentence[], annotations: AnnotationEntry[]): {
  humanVerifiable: number
  detected: number
  recall: number
} {
  const detectedSet = new Set(sentences.filter((s) => s.detected).map((s) => `${s.path}#${s.index}`))
  const human = annotations.filter((e) => e.predicate === 'verifiable')
  const hits = human.filter((e) => detectedSet.has(`${e.path}#${e.index}`))
  const recall = human.length === 0 ? 1 : hits.length / human.length
  return { humanVerifiable: human.length, detected: hits.length, recall }
}
