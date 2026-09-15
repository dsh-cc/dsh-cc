/**
 * MEMORY.md entrypoint bounds and truncation.
 * The entrypoint is the always-loaded index; its content is capped so a
 * runaway index cannot flood the system prompt.
 * @module @dsh-cc/memory/truncate
 */

import { Buffer } from 'node:buffer'

/** The always-loaded index filename inside a memory directory. */
export const ENTRYPOINT_NAME = 'MEMORY.md'

/** Line cap for the entrypoint index. */
export const MAX_ENTRYPOINT_LINES = 200

/** Byte cap for the entrypoint index (long lines are the failure mode). */
export const MAX_ENTRYPOINT_BYTES = 25_000

/**
 * Body caps for the truncated output: the appended warning banner adds ~2
 * lines / ~250 bytes, so the body is capped below the entrypoint limits and
 * the truncation output always satisfies the write-side gate.
 */
const BODY_LINE_CAP = MAX_ENTRYPOINT_LINES - 2
const BODY_BYTE_CAP = MAX_ENTRYPOINT_BYTES - 256

/** Result of applying the entrypoint caps. */
export interface EntrypointTruncation {
  /** Truncated content, plus a trailing warning line when a cap fired. */
  content: string
  /** Original trimmed line count (before any truncation). */
  lineCount: number
  /** Original trimmed byte count (before any truncation). */
  byteCount: number
  /** Whether the line cap fired. */
  wasLineTruncated: boolean
  /** Whether the byte cap fired (against the original, pre-line-cap size). */
  wasByteTruncated: boolean
}

/**
 * Truncate MEMORY.md content to the line AND byte caps. Line-truncates first
 * (a natural boundary), then byte-truncates at the last newline before the cap
 * so a line is never cut mid-way, then appends a warning that names which cap
 * fired. Unmodified content is returned unchanged.
 * @param raw - the raw entrypoint index text.
 * @returns the capped content and the cap flags.
 */
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  const contentLines = trimmed.split('\n')
  const lineCount = contentLines.length
  const byteCount = Buffer.byteLength(trimmed, 'utf8')

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, lineCount, byteCount, wasLineTruncated, wasByteTruncated }
  }

  // Byte-accurate slicing: accumulate whole lines (never mid-character) while
  // the running UTF-8 byte total fits the body budget.
  const bodyLines: string[] = []
  let runningBytes = 0
  for (const line of contentLines.slice(0, BODY_LINE_CAP)) {
    const cost = Buffer.byteLength(line, 'utf8') + (bodyLines.length > 0 ? 1 : 0)
    if (runningBytes + cost > BODY_BYTE_CAP) break
    bodyLines.push(line)
    runningBytes += cost
  }
  const truncated = bodyLines.join('\n')

  const size = byteCount >= 1024 ? `${(byteCount / 1024).toFixed(1)}KB` : `${byteCount}B`
  const reason = wasByteTruncated && !wasLineTruncated
    ? `${size} (limit: 25KB) — index entries are too long`
    : wasLineTruncated && !wasByteTruncated
      ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
      : `${lineCount} lines and ${size}`

  return {
    content: `${truncated}\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  }
}
