/**
 * Parsing for the memdir topic-file format: `---`-delimited YAML frontmatter
 * (name/description/type) plus a Markdown body. Binary parsing and the body
 * are deliberately decoupled so recall, the system-prompt section index, and
 * consolidation can each consume only what they need.
 * @module @dsh-cc/memory/parser
 */

import { parseMemoryType, type MemoryFrontmatter, type MemoryType } from './types.ts'

/**
 * One topic file separated into its rationalized header and Markdown body.
 * `undefined` marks a file that is not a valid memory topic (unreadable
 * frontmatter, or missing name/description).
 */
export interface ParsedMemoryFile {
  /** Rationalized frontmatter header. */
  frontmatter: MemoryFrontmatter
  /** The Markdown body after the closing `---`, trimmed of surrounding blanks. */
  body: string
}

/**
 * Parse one topic file's raw text into its frontmatter and body.
 * The header must open with a `---` line and close with a later `---` line;
 * `name` and `description` must be non-empty strings; `type` is optional and
 * unknown values are dropped. A malformed or incomplete file returns
 * `undefined` rather than throwing.
 * @param raw - the raw UTF-8 text of a memory topic file.
 * @returns the parsed header/body, or `undefined` when the file is not a topic.
 */
export function parseMemoryFile(raw: string): ParsedMemoryFile | undefined {
  const header = parseFrontmatterHeader(raw)
  if (header === undefined) return undefined
  const fields = parseScalarFields(header.body)
  const name = nonEmpty(fields.name)
  const description = nonEmpty(fields.description)
  if (name === undefined || description === undefined) return undefined
  return {
    frontmatter: { name, description, ...parseOptionalType(fields.type) },
    body: header.after.trim(),
  }
}

interface RawHeader {
  body: string
  after: string
}

/**
 * Split the `---`-delimited frontmatter block by scanning line-by-line.
 * Returns the YAML block body and the markdown text after the closing fence.
 */
function parseFrontmatterHeader(raw: string): RawHeader | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '')
  if (firstLine !== '---') return undefined
  let lineStart = firstLineEnd + 1
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      // `lineEnd + 1` is past the closing fence and any trailing newline; when
      // the fence is the last byte lineEnd === raw.length so the slice is empty.
      return {
        body: raw.slice(firstLineEnd + 1, lineStart),
        after: raw.slice(lineEnd + 1),
      }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

/** Parse the simple `key: value` scalar fields the memdir format uses. */
function parseScalarFields(yaml: string): Record<string, string | undefined> {
  const fields: Record<string, string | undefined> = {}
  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    if (key !== 'name' && key !== 'description' && key !== 'type') continue
    fields[key] = unquoteScalar(line.slice(colon + 1).trim())
  }
  return fields
}

/** Strip a single surrounding pair of quotes from a scalar value. */
function unquoteScalar(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/** Treat a missing or whitespace-only value as absent. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}

function parseOptionalType(type: string | undefined): { type: MemoryType } | {} {
  const parsed = parseMemoryType(type)
  return parsed === undefined ? {} : { type: parsed }
}
