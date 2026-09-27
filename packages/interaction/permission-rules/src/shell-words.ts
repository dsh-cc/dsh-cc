/**
 * Lexical shell-word helpers for the segment scanner and the grant surfaces
 * (assignment stripping + first-token computation). Pure, linear, browser-safe.
 * @module @dsh-cc/permission-rules/shell-words
 */

/** Quote states of one lexical frame. */
export type QuoteState = 'none' | 'single' | 'double' | 'ansi'

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

/**
 * The end index of one lexically complete shell word starting at `start`
 * (quotes, escapes, `$()`/backtick substitutions and `${…}` respected).
 */
function scanShellWord(text: string, start: number): number {
  let index = start
  let quote: QuoteState = 'none'
  let subst = 0
  let param = 0
  while (index < text.length) {
    const char = text[index]
    if (quote === 'single') {
      if (char === "'") quote = 'none'
      index += 1
      continue
    }
    if (quote === 'ansi') {
      if (char === '\\') index += 1
      else if (char === "'") quote = 'none'
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
    if (char === '$' && text[index + 1] === "'") {
      quote = 'ansi'
      index += 2
      continue
    }
    if (char === '$' && text[index + 1] === '(') {
      subst += 1
      index += 2
      continue
    }
    if (char === '$' && text[index + 1] === '{') {
      param += 1
      index += 2
      continue
    }
    if (char === '`') {
      subst += 1
      index += 1
      continue
    }
    if (char === ')' && subst > 0) {
      subst -= 1
      index += 1
      continue
    }
    if (char === '}' && param > 0) {
      param -= 1
      index += 1
      continue
    }
    if (subst === 0 && param === 0 && (char === ' ' || char === '\t' || char === '\n')) break
    index += 1
  }
  return index
}
