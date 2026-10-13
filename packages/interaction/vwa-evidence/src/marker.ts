/**
 * Marker and claim extraction (design
 * docs/plans/2026-10-12-verifiable-workspace-agent.md §4.2).
 *
 * Marker syntax: `〔src:<sourceId>#L<a>-L<b>〕` with FULL-WIDTH brackets,
 * recognized ONLY in prose (never in code spans or fenced blocks) — code
 * regions are masked out through a markdown-it AST pass (block-level
 * `fence`/`code_block`/`html_block`/`math_block` token maps) plus a
 * per-line inline-code-span scanner, both length-preserving so every span
 * stays a UTF-16 code-unit index into the ORIGINAL artifact text.
 *
 * v1 sourceId vocabulary: `ws:<posix path relative to workspace root>` only.
 * Multiple sources inside one marker join with `;`.
 *
 * Claim detection is a frozen four-regex family, pinned by package tests:
 * (a) numbers with units/percentages, (b) ISO dates, (c) version strings,
 * (d) API/identifier shapes. Entity names are OUT of detection by design.
 * Sentence boundaries: newline and `.!?`。！？. A document with no detected
 * claims yields zero claims (overall abstained upstream); malformed markers
 * do not verify (status `invalid-marker`).
 *
 * @module @dsh-cc/vwa-evidence/marker
 */

import MarkdownIt from 'markdown-it'

/** Full-width brackets — handled only through tool-written files (encoding class). */
export const MARKER_OPEN = '〔'
export const MARKER_CLOSE = '〕'

// 'zero' preset disables every rule; enable exactly the block rules whose
// token maps drive the mask (fences, indented code, HTML blocks).
const md: MarkdownIt = new MarkdownIt('zero', { breaks: false })
md.enable(['paragraph', 'heading', 'fence', 'code', 'html_block', 'blockquote', 'list'])

/** One parsed source spec inside a marker. */
export interface SourceSpec {
  sourceId: string
  lineStart: number
  lineEnd: number
}

/** One marker occurrence found in prose. */
export interface MarkerOccurrence {
  /** UTF-16 span of the whole marker in the artifact text. */
  span: [number, number]
  specs: SourceSpec[]
  /** False when the marker text is present but unparseable (§4.2 malformed). */
  parsed: boolean
}

export interface Extraction {
  /** Sentences containing at least one four-family detection. */
  claims: { span: [number, number]; text: string; markers: MarkerOccurrence[] }[]
  /** (a)-family facts (§4.1 numbers[] rows; paramsHash is a v1 placeholder). */
  numbers: { span: [number, number]; ref: string }[]
}

/**
 * Length-preserving prose mask: code spans, fenced/indented code blocks,
 * HTML blocks and math blocks become spaces so markers and claims can only
 * be detected in prose, while every UTF-16 offset in the mask equals the
 * offset in the original text.
 */
export function proseMask(text: string): string {
  // Length-preserving copy of the ORIGINAL text in UTF-16 CODE UNITS (the
// span pin, not an implementation detail): `split('')` splits into code
// units, so emoji/CJK surrogate pairs stay two slots. Masked ranges are
// blanked below; `Array.from` would collapse pairs and shift every offset.
const mask = text.split('')
  const maskRange = (start: number, end: number): void => {
    for (let i = Math.max(0, start); i < Math.min(mask.length, end); i++) {
      if (mask[i] !== '\n') mask[i] = ' '
    }
  }
  const lines = text.split('\n')
  const lineStarts: number[] = []
  let offset = 0
  for (const line of lines) {
    lineStarts.push(offset)
    offset += line.length + 1
  }
  // Block-level pass: use the AST's line maps (the AST's only stable offsets).
  for (const token of md.parse(text, {})) {
    if (['fence', 'code_block', 'html_block', 'math_block'].includes(token.type) && token.map) {
      const [startLine, endLine] = token.map
      maskRange(lineStarts[startLine] ?? text.length, (lineStarts[endLine] ?? text.length + 1) - 1)
    }
  }
  // Inline pass: per unmasked line, blank backtick-delimited code spans
  // (n opening backticks ... n closing backticks), length-preserving.
  for (let li = 0; li < lines.length; li++) {
    const start = lineStarts[li] ?? 0
    const line = lines[li] ?? ''
    let i = 0
    while (i < line.length) {
      if (line[i] !== '`') {
        i++
        continue
      }
      let run = 0
      while (line[i + run] === '`') run++
      const openStart = i
      let close = -1
      let j = i + run
      while (j < line.length) {
        if (line[j] === '`') {
          let run2 = 0
          while (line[j + run2] === '`') run2++
          if (run2 === run) {
            close = j + run2
            break
          }
          j += run2
        } else {
          j++
        }
      }
      if (close > 0) {
        maskRange(start + openStart, start + close)
        i = close
      } else {
        i += run
      }
    }
  }
  return mask.join('')
}

/**
 * Parse the inner text of one marker (between the full-width brackets).
 * Multiple sources join with `;`. Returns null when any spec is malformed.
 */
export function parseMarkerInner(inner: string): SourceSpec[] | null {
  if (!inner.startsWith('src:')) return null
  const specs: SourceSpec[] = []
  for (const part of inner.slice(4).split(';')) {
    const match = /^ws:(.+)#L(\d+)-L(\d+)$/.exec(part)
    if (match === null) return null
    const [, sourceId, a, b] = match as unknown as [string, string, string, string]
    const lineStart = Number(a)
    const lineEnd = Number(b)
    if (lineStart < 1 || lineEnd < lineStart) return null
    specs.push({ sourceId: `ws:${sourceId}`, lineStart, lineEnd })
  }
  return specs.length > 0 ? specs : null
}

/**
 * Find all markers in prose (the masked text), with spans valid in the
 * original text.
 */
export function findMarkers(maskedText: string): MarkerOccurrence[] {
  const out: MarkerOccurrence[] = []
  const re = new RegExp(`${MARKER_OPEN}([^${MARKER_CLOSE}]*)${MARKER_CLOSE}`, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(maskedText)) !== null) {
    const specs = parseMarkerInner(match[1] ?? '')
    out.push({ span: [match.index, match.index + match[0].length], specs: specs ?? [], parsed: specs !== null })
  }
  return out
}

/**
 * FROZEN four-family claim detection (§4.2). Each regex has a pinned
 * positive AND negative case in tests/detect.spec.ts. Entity names are out
 * of detection by design (no deterministic criterion).
 */
export const CLAIM_DETECTORS = {
  /** (a) numbers with units/percentages: `90%`, `30s`, `5 files`, `1.5 MB`. */
  numbersWithUnits:
    /\b\d+(?:\.\d+)?\s?(?:%|percent|bytes?|[kmgtp]ib|[kmgtp]?b|ms|s|min(?:ute)?s?|hours?|hrs?|days?|weeks?|px|pt|em|rem|tokens?|rows?|files?|lines?|entries?|items?|rounds?|requests?|qps|rps)(?![A-Za-z])/i,
  /** (b) ISO dates: `2026-10-12`, optionally with time/zone. */
  isoDate:
    /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?\b/,
  /** (c) version strings: `v1.2`, `1.2.3` (`v?\d+\.\d+` shape per §4.2). */
  versionString: /\b[vV]?\d+\.\d+(?:\.\d+)*\b/,
} as const

/** (d) API/identifier shapes: `xx()`, camelCase/UpperCamelCase, CONST_CASE, quoted config keys. */
export const IDENTIFIER_DETECTORS = {
  call: /\b[A-Za-z_$][A-Za-z0-9_$]*\(\)/,
  camel: /\b[a-zA-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/,
  constCase: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/,
  quotedKey: /['"`][a-z][a-z0-9-]*['"`]/,
} as const

/** Sentence terminators: newline and `.!?` plus the full-width `。！？` (§4.2). */
const SENTENCE_BOUNDARY = /[.!?。！？\n]/

function detectInSentence(masked: string): boolean {
  return (
    CLAIM_DETECTORS.numbersWithUnits.test(masked) ||
    CLAIM_DETECTORS.isoDate.test(masked) ||
    CLAIM_DETECTORS.versionString.test(masked) ||
    Object.values(IDENTIFIER_DETECTORS).some(re => re.test(masked))
  )
}

/**
 * Extract claims and (a)-family number facts from an artifact.
 * `text` is the ORIGINAL artifact text; detection runs on the prose mask,
 * while every emitted span and `text` slice is in original coordinates
 * (UTF-16 code-unit indices). `claim.text` = first 200 chars of the
 * sentence. Markers inside the sentence attach to the claim; a document
 * with no detected claims yields zero claims (§4.2 abstained upstream).
 */
export function extractClaims(text: string): Extraction {
  const masked = proseMask(text)
  const markers = findMarkers(masked)
  const claims: Extraction['claims'] = []
  const numbers: Extraction['numbers'] = []
  const sentenceIsClaim = (sentence: string): boolean => detectInSentence(sentence)
  let start = 0
  for (let i = 0; i <= masked.length; i++) {
    const atEnd = i === masked.length
    const ch = masked[i] ?? ''
    // A '.' between digits (decimals, versions) and any position inside a
    // marker span is NOT a sentence boundary — otherwise `v1.2` and
    // `docs/a.md` fragment sentences and markers straddle them.
    const insideMarker = markers.some(m => i > m.span[0] && i < m.span[1])
    const decimalDot = ch === '.' && /\d/.test(masked[i - 1] ?? '') && /\d/.test(masked[i + 1] ?? '')
    if (!atEnd && (!SENTENCE_BOUNDARY.test(ch) || insideMarker || decimalDot)) continue
    // sentence spans [start, end] INCLUDING the terminator (or EOF).
    const end = atEnd ? i : i + 1
    const sentenceMasked = masked.slice(start, end)
    const markersIn = markers.filter(m => m.span[0] >= start && m.span[1] <= end)
    if (sentenceMasked.trim().length > 0 && (sentenceIsClaim(sentenceMasked) || markersIn.length > 0)) {
      const raw = text.slice(start, end)
      claims.push({ span: [start, end], text: raw.slice(0, 200), markers: markersIn })
      // (a)-family rows: number/percentage facts with offsets in raw text.
      // Local global copy: the pinned detector itself is non-global, so
      // exec-ing it in a loop would never advance (infinite loop).
      const gre = new RegExp(CLAIM_DETECTORS.numbersWithUnits.source, CLAIM_DETECTORS.numbersWithUnits.flags + 'g')
      let m: RegExpExecArray | null
      while ((m = gre.exec(sentenceMasked)) !== null) {
        numbers.push({ span: [start + m.index, start + m.index + m[0].length], ref: m[0] })
        if (m.index === gre.lastIndex) gre.lastIndex++
      }
    }
    start = i + 1
  }
  return { claims, numbers }
}


