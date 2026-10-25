/**
 * Mechanical preservation compare and review-coverage checks (plan §5.5, §5.6, §8, §8.1).
 *
 * Mechanical equality never proves semantic equality. These checks only report
 * lexical differences in exact Markdown source; dispositions stay pending for
 * the semantic reviewer to resolve. Checks return the same result shape as the
 * schema validators: {ok:true, value} or {ok:false, code, message, details}.
 */

import { invalid, isPlainObject, validate } from './schema.lib.mjs'
import {
  footnoteRefTokens,
  linkDestinationTokens,
  maskProtected,
  numberTokens,
  quoteTokensForLine,
  scanBlocks,
  sourceMarkerTokens,
} from './markdown.lib.mjs'

function countMap(items) {
  const counts = new Map()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  return counts
}

/** Multiset difference with multiplicity, in first-occurrence order. */
function multisetDifference(before, after) {
  const countsBefore = countMap(before)
  const countsAfter = countMap(after)
  const seen = new Set()
  const beforeDiff = []
  const afterDiff = []
  for (const token of [...before, ...after]) {
    if (seen.has(token)) continue
    seen.add(token)
    const countBefore = countsBefore.get(token) ?? 0
    const countAfter = countsAfter.get(token) ?? 0
    if (countBefore === countAfter) continue
    for (let i = 0; i < countBefore; i++) beforeDiff.push(token)
    for (let i = 0; i < countAfter; i++) afterDiff.push(token)
  }
  return beforeDiff.length === 0 && afterDiff.length === 0 ? null : { before: beforeDiff, after: afterDiff }
}

/** Ordered byte-sequence difference; reports the full sequences when unequal. */
function sequenceDifference(before, after) {
  if (before.length === after.length && before.every((value, i) => value === after[i])) return null
  return { before, after }
}

function regionText(scan, text, kind) {
  return scan.protectedRegions.filter((r) => r.kind === kind).map((r) => text.slice(r.start, r.end))
}

function collect(text, scan, terms) {
  const masked = maskProtected(text, scan.protectedRegions)
  const citations = [...sourceMarkerTokens(masked), ...footnoteRefTokens(masked)]
  const links = linkDestinationTokens(masked)

  // Digits belonging to citations, links, and protected terms are not prose numbers.
  const numberMask = [
    ...citations.map((entry) => ({ start: entry.start, end: entry.end })),
    ...links.map((entry) => ({ start: entry.start, end: entry.end })),
  ]
  for (const term of terms) {
    if (term === '') continue
    let at = masked.indexOf(term)
    while (at !== -1) {
      numberMask.push({ start: at, end: at + term.length })
      at = masked.indexOf(term, at + 1)
    }
  }
  const numberSource = maskProtected(masked, numberMask)

  const quotes = []
  for (const block of scan.blocks) {
    const inline = scan.protectedRegions
      .filter((r) => r.kind === 'inline-code' && r.start >= block.start && r.end <= block.end)
      .map((r) => [r.start - block.start, r.end - block.start])
    let offset = 0
    for (const raw of text.slice(block.start, block.end).split('\n')) {
      const content = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      const skip = inline
        .filter(([start]) => start >= offset && start < offset + raw.length + 1)
        .map(([start, end]) => [start - offset, end - offset])
      quotes.push(...quoteTokensForLine(content, skip).tokens)
      offset += raw.length + 1
    }
  }

  return {
    numbers: numberTokens(numberSource).map((entry) => entry.token),
    quotes,
    citations: citations.map((entry) => entry.token),
    links: links.map((entry) => entry.token),
    frontmatter: regionText(scan, text, 'frontmatter'),
    fencedCode: regionText(scan, text, 'fenced-code'),
    inlineCode: regionText(scan, text, 'inline-code'),
  }
}

function termsOf(opts) {
  return [
    ...new Set([
      ...(opts.protectedTerms ?? []),
      ...(opts.profileProtectedTerms ?? []),
      ...(opts.profile?.protectedTerms ?? []),
    ]),
  ]
}

function termOccurrences(text, term) {
  const occurrences = []
  if (term === '') return occurrences
  let at = text.indexOf(term)
  while (at !== -1) {
    occurrences.push(term)
    at = text.indexOf(term, at + 1)
  }
  return occurrences
}

function change(type, difference) {
  if (difference === null) return null
  return { type, before: difference.before, after: difference.after, disposition: 'pending', reason: null }
}

/**
 * Compare two Markdown bodies mechanically.
 *
 * @param {string} before
 * @param {string} after
 * @param {{protectedTerms?: string[], profileProtectedTerms?: string[],
 *          profile?: {protectedTerms?: string[]}}} [opts]
 * @returns {{type:string,before:string[],after:string[],disposition:'pending',reason:null}[]}
 */
export function compareBodies(before, after, opts = {}) {
  if (typeof before !== 'string' || typeof after !== 'string') {
    throw new TypeError('compareBodies: before and after must be strings')
  }
  const terms = termsOf(opts)
  const scanBefore = scanBlocks(before)
  const scanAfter = scanBlocks(after)
  const a = collect(before, scanBefore, terms)
  const b = collect(after, scanAfter, terms)

  const changes = [
    change('number', multisetDifference(a.numbers, b.numbers)),
    change('quotation', multisetDifference(a.quotes, b.quotes)),
    change('citation', multisetDifference(a.citations, b.citations)),
    change('link', multisetDifference(a.links, b.links)),
    change('code', sequenceDifference(a.frontmatter, b.frontmatter)),
    change('code', sequenceDifference(a.fencedCode, b.fencedCode)),
    change('code', sequenceDifference(a.inlineCode, b.inlineCode)),
  ].filter((entry) => entry !== null)

  for (const term of terms) {
    const difference = multisetDifference(termOccurrences(before, term), termOccurrences(after, term))
    const entry = change('term', difference)
    if (entry !== null) changes.push(entry)
  }
  return changes
}

function blockIndexOf(blocks, edited) {
  if (typeof edited === 'number') return Number.isSafeInteger(edited) && edited >= 0 && edited < blocks.length ? edited : -1
  if (!isPlainObject(edited)) return -1
  return blocks.findIndex((block) => block.start === edited.start && block.end === edited.end)
}

function requiredRanges(stage, scannerOutput) {
  const blocks = scannerOutput.blocks ?? []
  if (stage !== 'semantics') return blocks.map((block) => ({ start: block.start, end: block.end }))
  const edited = scannerOutput.editedBlocks ?? []
  if (!Array.isArray(edited)) invalid('scannerOutput.editedBlocks: expected an array')
  if (edited.length === 0) return []
  const indexes = new Set()
  for (const entry of edited) {
    const index = blockIndexOf(blocks, entry)
    if (index === -1) invalid('scannerOutput.editedBlocks: an edited block is not present in the snapshot')
    indexes.add(index)
    if (index > 0) indexes.add(index - 1)
    if (index + 1 < blocks.length) indexes.add(index + 1)
  }
  return [...indexes].sort((x, y) => x - y).map((index) => ({ start: blocks[index].start, end: blocks[index].end }))
}

/**
 * Validate a review's declared coverage against deterministic block offsets.
 *
 * @param {{coverage:string, coverageRanges:{start:number,end:number}[]}} review
 * @param {{blocks:object[], length?:number, editedBlocks?:(number|{start:number,end:number})[]}} scannerOutput
 * @param {'structure'|'language'|'semantics'} stage
 */
export function validateCoverage(review, scannerOutput, stage) {
  if (!['structure', 'language', 'semantics'].includes(stage)) {
    return { ok: false, code: 'INVALID_INPUT', message: `stage: expected structure, language, or semantics`, details: {} }
  }
  if (!isPlainObject(review)) {
    return { ok: false, code: 'INVALID_INPUT', message: 'review: expected an object', details: {} }
  }
  if (review.coverage !== 'complete') {
    return {
      ok: false,
      code: 'REVIEW_INCOMPLETE',
      message: `coverage: ${stage} review is ${String(review.coverage)}; partial coverage cannot satisfy completion`,
      details: { stage },
    }
  }
  return validate(() => {
    if (!Array.isArray(scannerOutput?.blocks)) invalid('scannerOutput.blocks: expected an array')
    if (!Array.isArray(review.coverageRanges)) invalid('review.coverageRanges: expected an array')
    const ranges = review.coverageRanges.map((range, index) => {
      const at = `review.coverageRanges[${index}]`
      if (!isPlainObject(range)) invalid(`${at}: expected an object`)
      for (const key of Object.keys(range)) {
        if (key !== 'start' && key !== 'end') invalid(`${at}: unknown property "${key}"`)
      }
      if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)) {
        invalid(`${at}: expected integer offsets`)
      }
      if (range.start < 0 || range.end < range.start) invalid(`${at}: invalid range ${range.start}..${range.end}`)
      if (Number.isSafeInteger(scannerOutput.length) && range.end > scannerOutput.length) {
        invalid(`${at}: range ends outside the snapshot`)
      }
      return { start: range.start, end: range.end }
    })
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i].start < ranges[i - 1].end) invalid('review.coverageRanges: ranges must be ordered and nonoverlapping')
    }
    const required = requiredRanges(stage, scannerOutput)
    const sameLength = ranges.length === required.length
    const tiled = sameLength && ranges.every((range, i) => range.start === required[i].start && range.end === required[i].end)
    if (!tiled) invalid(`review.coverageRanges: ranges do not exactly tile the required ${stage} blocks`)
    return { stage, ranges }
  })
}

function isMidSurrogate(text, index) {
  if (index <= 0 || index >= text.length) return false
  const previous = text.charCodeAt(index - 1)
  const current = text.charCodeAt(index)
  return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff
}

/**
 * Validate model spans against the exact snapshot bytes.
 *
 * @param {string} snapshotText
 * @param {{start:number,end:number,quote?:string}[]} spans
 */
export function checkSpans(snapshotText, spans) {
  return validate(() => {
    if (typeof snapshotText !== 'string') invalid('snapshotText: expected a string')
    if (!Array.isArray(spans)) invalid('spans: expected an array')
    return spans.map((span, index) => {
      const at = `spans[${index}]`
      if (!isPlainObject(span)) invalid(`${at}: expected an object`)
      for (const key of Object.keys(span)) {
        if (!['start', 'end', 'quote'].includes(key)) invalid(`${at}: unknown property "${key}"`)
      }
      if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)) {
        invalid(`${at}: expected integer offsets`)
      }
      if (span.start < 0 || span.end < span.start || span.end > snapshotText.length) {
        invalid(`${at}: span ${span.start}..${span.end} is outside the snapshot`)
      }
      if (isMidSurrogate(snapshotText, span.start) || isMidSurrogate(snapshotText, span.end)) {
        invalid(`${at}: span boundary falls inside a surrogate pair`)
      }
      if (span.quote !== undefined) {
        if (typeof span.quote !== 'string') invalid(`${at}: quote: expected a string`)
        if (snapshotText.slice(span.start, span.end) !== span.quote) {
          invalid(`${at}: quote does not match snapshot bytes`)
        }
      }
      return { start: span.start, end: span.end, quote: snapshotText.slice(span.start, span.end) }
    })
  })
}
