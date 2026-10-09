/**
 * Minimal lexical shell-word helpers for first-token/head extraction
 * (design doc docs/plans/2026-10-09-verify-before-retry.md §3.2). Local copy
 * of the `permission-rules` parse style — the package boundary forbids
 * importing its internals; ~30 lines of duplication is accepted deliberately.
 * Pure, linear, browser-safe.
 *
 * @module
 */

/** Strip leading `NAME=value` assignment words (repeatedly, lexically). */
export function stripLeadingAssignments(text: string): string {
  let index = skipWhitespace(text, 0)
  let stripped = false
  while (index < text.length) {
    const nameEnd = scanIdentifier(text, index)
    if (nameEnd === index || text[nameEnd] !== '=') break
    const afterValue = scanShellWord(text, nameEnd + 1)
    index = skipWhitespace(text, afterValue)
    stripped = true
  }
  return stripped ? text.slice(index) : text
}

/** The first whitespace-delimited token of `text` with quote chars consumed. */
export function firstShellToken(text: string): string {
  let index = skipWhitespace(text, 0)
  let token = ''
  while (index < text.length) {
    const char = text[index]
    if (char === ' ' || char === '\t' || char === '\n') break
    if (char === '"' || char === "'") {
      index += 1
      continue
    }
    if (char === '\\' && index + 1 < text.length) {
      token += text[index + 1]
      index += 2
      continue
    }
    token += char
    index += 1
  }
  return token
}

/** The second whitespace-delimited token (after assignments are stripped), '' when absent. */
export function secondShellToken(text: string): string {
  const stripped = stripLeadingAssignments(text)
  let index = skipWhitespace(stripped, 0)
  while (index < stripped.length && stripped[index] !== ' ' && stripped[index] !== '\t' && stripped[index] !== '\n') index += 1
  return firstShellToken(stripped.slice(index))
}

/** Next index at or after `start` that is not a space/tab/newline. */
function skipWhitespace(text: string, start: number): number {
  let index = start
  while (index < text.length && (text[index] === ' ' || text[index] === '\t' || text[index] === '\n')) index += 1
  return index
}

/** The end index of an identifier run `[A-Za-z_][A-Za-z0-9_]*` from `start`. */
function scanIdentifier(text: string, start: number): number {
  const first = text[start]
  if (first === undefined || !(first === '_' || (first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z'))) return start
  let index = start + 1
  while (index < text.length) {
    const char = text[index]
    if (char !== undefined && (char === '_' || (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9'))) {
      index += 1
      continue
    }
    break
  }
  return index
}

/** The end index of one lexically complete shell word starting at `start` (quotes and escapes respected). */
function scanShellWord(text: string, start: number): number {
  let index = start
  let quote: 'none' | 'single' | 'double' = 'none'
  while (index < text.length) {
    const char = text[index]
    if (quote === 'single') {
      if (char === "'") quote = 'none'
      index += 1
      continue
    }
    if (quote === 'double') {
      if (char === '\\') index += 1
      else if (char === '"') quote = 'none'
      index += 1
      continue
    }
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === "'") {
      quote = 'single'
      index += 1
      continue
    }
    if (char === '"') {
      quote = 'double'
      index += 1
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n') break
    index += 1
  }
  return index
}
