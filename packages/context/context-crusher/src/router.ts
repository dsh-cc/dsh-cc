/**
 * Pure, deterministic content routing and compression (no I/O).
 *
 * Two Phase-0 compressors, both conservative: if the input does not cleanly
 * match the format's structure the router returns `null` and the listener
 * passes the result through untouched. Every line carrying an error or match
 * signal survives; only repetitive context is dropped.
 *
 * @module @dsh-cc/context-crusher/router
 */

export type CompressedKind = 'search' | 'log'

/** A safe compression, or `null` = no safe saving → passthrough. */
export interface CompressedCandidate {
  readonly text: string
  readonly kind: CompressedKind
}

/**
 * Minimum structural evidence before a compressor claims an input: fewer
 * candidate lines than this is not a confident format match.
 */
const MIN_EVIDENCE_LINES = 3

/** Share of non-empty lines that must match a format for a confident claim. */
const MIN_EVIDENCE_RATIO = 0.6

/** Log-shaped output needs weaker evidence than grep rows (banners are sparse). */
const MIN_LOG_RATIO = 0.3

/** Ripgrep/grep `file:line:content` row: path without spaces or colons, digits. */
const SEARCH_ROW = /^(\.{0,2}\/?[\w.@\/-]+?):(\d+):(.*)$/

/** Non-search rows that would make a search claim unsafe (paths contain `:`? no). */
function isSearchRow(line: string): boolean {
  return SEARCH_ROW.test(line)
}

/**
 * Compress grep-style output: cluster consecutive rows per file, emit the
 * path once, then `line:content` per row. Every matching line and every file
 * path survives; only the repeated path prefixes are dropped.
 */
function compressSearch(text: string): string {
  const clusters = new Map<string, string[]>() // file → `lineNo:content` rows, first-appearance order
  const loose: string[] = []
  for (const line of text.split('\n')) {
    const match = SEARCH_ROW.exec(line)
    if (match === null) {
      loose.push(line)
      continue
    }
    const [file, lineNo, content] = [match[1] ?? '', match[2] ?? '', match[3] ?? '']
    const rows = clusters.get(file) ?? []
    rows.push(`${lineNo}:${content}`)
    clusters.set(file, rows)
  }
  const out: string[] = [...loose]
  for (const [file, rows] of clusters) {
    out.push(`== ${file} ==`, ...rows)
  }
  return out.join('\n')
}

/** Lines that carry an error/failure signal and are always preserved. */
const LOG_SIGNAL = [
  /\b(ERROR|FATAL|ERR!|FAIL(?:ED|URE)?|Traceback|panic|exception)\b/i,
  /^\s+at\s/, // JS stack frame
  /^\s+File "/, // Python stack frame
  /^npm ERR!/,
  /^=+ .* =+$/, // pytest banner
  /^\s*(?:Failed|Error):/,
]

function isLogSignal(line: string): boolean {
  return LOG_SIGNAL.some((re) => re.test(line))
}

/** Lines that identify log-shaped output (timestamps, levels, tool banners). */
const LOG_MARKER = [
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/,
  /^\d{2}:\d{2}:\d{2}[.,]?\d*/,
  /\b(WARN|INFO|DEBUG|TRACE)\b/,
  /^npm (WARN|notice)/,
  /^(PASS|OK|PASSED|passed)\b/,
  /^(✓|√|✔)/,
]

function isLogMarker(line: string): boolean {
  return LOG_MARKER.some((re) => re.test(line)) || isLogSignal(line)
}

/** Non-signal lines kept at the head of each cluster, for orientation. */
const KEEP_HEAD = 3

/**
 * Compress log output: keep every error/signal line and stack frame, keep the
 * first {@link KEEP_HEAD} lines of each contiguous non-signal cluster, elide
 * the rest with an explicit count so the shape stays honest.
 */
function compressLog(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let run: string[] = []
  const flush = () => {
    if (run.length === 0) return
    if (run.length <= KEEP_HEAD) {
      out.push(...run)
    } else {
      out.push(...run.slice(0, KEEP_HEAD))
      out.push(`[… ${run.length - KEEP_HEAD} lines elided by dsh-cc log compression …]`)
    }
    run = []
  }
  for (const line of lines) {
    if (isLogSignal(line) || line === '') {
      flush()
      out.push(line)
    } else {
      run.push(line)
    }
  }
  flush()
  return out.join('\n')
}

/**
 * Route one tool-result text to a compressor.
 * @param text - the joined tool-result text.
 * @returns a compressed candidate, or `null` when the input does not cleanly
 *   match a known format or would not compress.
 */
export function route(text: string): CompressedCandidate | null {
  if (text.length === 0) return null
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length < MIN_EVIDENCE_LINES) return null
  const searchRows = lines.filter((l) => isSearchRow(l)).length
  if (searchRows >= MIN_EVIDENCE_LINES && searchRows / lines.length >= MIN_EVIDENCE_RATIO) {
    return { text: compressSearch(text), kind: 'search' }
  }
  const logLines = lines.filter((l) => isLogMarker(l)).length
  if (logLines >= MIN_EVIDENCE_LINES && logLines / lines.length >= MIN_LOG_RATIO) {
    return { text: compressLog(text), kind: 'log' }
  }
  return null
}
