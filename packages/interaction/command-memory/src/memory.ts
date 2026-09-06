/**
 * Pure `/memory` rendering helpers: first-line extraction, index formatting,
 * and single-memory formatting. Filesystem access and body reads happen in the
 * command's handler; these functions only shape already-loaded data, so they
 * are unit-testable without cordis or an fs seam.
 * @module @dsh-cc/command-memory/memory
 */

/** A compact index line for one memory topic. */
export interface MemoryIndexLine {
  /** Topic name from frontmatter (or its filename). */
  readonly name: string
  /** Optional declared type. */
  readonly type?: string
  /** The topic body's first non-empty line. */
  readonly firstLine: string
}

/** The first non-empty line of a body, or a placeholder when empty. */
export function firstLine(body: string): string {
  const line = body.split('\n').find(text => text.trim().length > 0)
  return line === undefined ? '(empty)' : line.trim()
}

/** Render one index line as `name (type)` followed by its first body line. */
export function formatIndexLine(line: MemoryIndexLine): string {
  const typed = line.type === undefined ? line.name : `${line.name} (${line.type})`
  return `- ${typed} — ${line.firstLine}`
}

/**
 * Render the memory directory index.
 * @param dir - the scanned directory path (used as the header).
 * @param lines - the enriched topic index lines, already sorted.
 * @returns the index report, or a placeholder when no topics exist.
 */
export function formatIndex(dir: string, lines: readonly MemoryIndexLine[]): string {
  const out = [`Memory directory: ${dir}`]
  if (lines.length === 0) {
    out.push('No memory topics.')
    return out.join('\n')
  }
  for (const line of lines) out.push(formatIndexLine(line))
  return out.join('\n')
}

/** Format one fully-loaded memory's body for display. */
export function formatMemory(
  name: string,
  filename: string,
  type: string | undefined,
  description: string,
  body: string,
): string {
  const out = [`# ${name}`, `file: ${filename}`]
  if (type !== undefined) out.push(`type: ${type}`)
  if (description.length > 0) out.push(description)
  out.push('', body)
  return out.join('\n')
}
