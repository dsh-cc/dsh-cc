/**
 * Marker stripping for the render pipeline (design
 * `docs/plans/2026-11-15-vwa-autonomous-render-pipeline.md` §4.5).
 *
 * A draft is the authoring surface with inline `〔src:…〕`/`〔claim:…〕`
 * markers; the deliverable is the marker-free render. Removal is uniform —
 * inside code spans and fences too — because uniform removal is the only
 * deterministic rule. Documented consequence: a document that must display a
 * marker literally cannot be authored as a draft verbatim.
 *
 * Two offset maps are exposed because the directions are NOT inverses at
 * removal seams: `draftToRendered` collapses every removed range to one
 * rendered point (a plateau), while `renderedToDraft` is right-biased at a
 * seam (it maps to the first offset AFTER the removed range). All offsets
 * are UTF-16 code units — the same indices `String.prototype.slice` and the
 * persisted `Span` type use; surrogate pairs need no special casing because
 * markers are BMP characters and shifts are computed per code unit.
 *
 * Endpoint affinity for spans is half-open `[start, end)` —
 * {@link intersectsRemoved} is the §4.2 step-5 predicate: a span whose start
 * falls strictly inside a removed range is rejected, while a span whose end
 * equals a removed range's start is valid.
 *
 * This module deliberately does NOT reuse `stripClaimMarkers`'s
 * `strippedToOriginal` (audit-input.ts): that map exists in one direction
 * only and is right-biased at boundaries.
 *
 * @module @dsh-cc/vwa-argument/render
 */

/** The one marker grammar the render strips (§4.5), `/g` state not shared across calls. */
function markerRe(): RegExp {
  return /〔(?:src|claim):[^〕]*〕/g
}

/** A removed marker range in draft coordinates, half-open `[start, end)`. */
export interface RemovedRange {
  start: number
  end: number
}

/** The marker-free render plus the coordinate maps between the two texts. */
export interface RenderResult {
  /** The deliverable text (every marker occurrence removed). */
  text: string
  /** Removed marker ranges in draft coordinates, ascending, non-overlapping. */
  removed: RemovedRange[]
  /**
   * Draft offset → rendered offset. Monotone non-decreasing; constant over
   * each removed range's interior and its two endpoints (the range collapses
   * to the rendered offset of its start).
   */
  draftToRendered(offset: number): number
  /**
   * Rendered offset → draft offset. Right-biased at a removal seam: the
   * first rendered offset after a collapsed range maps to the first draft
   * offset AFTER the removed range.
   */
  renderedToDraft(offset: number): number
}

/**
 * Strip every `〔src:…〕`/`〔claim:…〕` occurrence from a draft (§4.5).
 */
export function stripMarkers(draft: string): RenderResult {
  const removed: RemovedRange[] = []
  const re = markerRe()
  let match: RegExpExecArray | null
  while ((match = re.exec(draft)) !== null) {
    removed.push({ start: match.index, end: match.index + match[0].length })
  }
  let text = ''
  let cursor = 0
  for (const range of removed) {
    text += draft.slice(cursor, range.start)
    cursor = range.end
  }
  text += draft.slice(cursor)
  return {
    text,
    removed,
    // Characters strictly before `offset` that a removed range covers are
    // gone from the render; inside a range the count plateaus, so the whole
    // range (endpoints included) maps to one rendered point.
    draftToRendered(offset: number): number {
      let shift = 0
      for (const range of removed) {
        if (offset <= range.start) break
        shift += Math.min(offset, range.end) - range.start
      }
      return offset - shift
    },
    renderedToDraft(offset: number): number {
      let shift = 0
      for (const range of removed) {
        if (offset < range.start - shift) break
        shift += range.end - range.start
      }
      return offset + shift
    },
  }
}

/**
 * §4.2 step 5, half-open `[start, end)` intersection: true when the span
 * covers any character of a removed marker range. Endpoint affinity: a span
 * whose `end` equals a removed range's `start` (or whose `start` equals a
 * removed range's `end`) does NOT intersect.
 */
export function intersectsRemoved(span: { start: number; end: number }, removed: readonly RemovedRange[]): boolean {
  return removed.some((range) => span.start < range.end && range.start < span.end)
}
