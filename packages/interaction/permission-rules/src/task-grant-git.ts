/** Conservative Git argv parsing shared by task-grant admission and content checks. */
import type { ShellSegment } from './shell-segments.ts'

export type TaskGrantGitInvocation =
  | { readonly kind: 'other' }
  | { readonly kind: 'unsupported'; readonly reason: 'config' | 'assignment' | 'global-options' | 'syntax' | 'subcommand' }
  | { readonly kind: 'git'; readonly subcommand: string; readonly args: readonly string[] }

/** Decode literal shell words only; expansions and redirections are not known argv. */
function literalWords(text: string): string[] | undefined {
  const words: string[] = []
  let word = ''
  let active = false
  let quote: 'single' | 'double' | undefined
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quote === 'single') {
      if (char === "'") quote = undefined
      else word += char
      continue
    }
    if (char === '$' || char === '`') return undefined
    if (char === '\\') {
      const next = text[++index]
      if (next === undefined) return undefined
      if (quote === 'double' && !['$', '`', '"', '\\', '\n'].includes(next)) word += '\\'
      if (next !== '\n') word += next
      active = true
      continue
    }
    if (quote === 'double') {
      if (char === '"') quote = undefined
      else word += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char === "'" ? 'single' : 'double'
      active = true
    } else if (/\s/.test(char)) {
      if (active) words.push(word)
      word = ''
      active = false
    } else {
      if ('*?[]{}~<>|;&()'.includes(char)) return undefined
      word += char
      active = true
    }
  }
  if (quote !== undefined) return undefined
  if (active) words.push(word)
  return words
}

/**
 * Recognize literal `git <subcommand>` only. All global options are unsupported:
 * their argv/config effects would invalidate the root and content checks.
 * Harmless assignments on other subcommands retain raw-prefix shell semantics.
 */
export function parseTaskGrantGitInvocation(segment: ShellSegment): TaskGrantGitInvocation {
  if (segment.first !== 'git') return { kind: 'other' }
  const words = literalWords(segment.subject)
  if (segment.tainted || words === undefined || words[0] !== 'git') return { kind: 'unsupported', reason: 'syntax' }
  // Command and subcommand must be literal source, even if decoding quotes
  // would produce the same argv: content prefixes are literal as well.
  const source = segment.subject.trim().split(/\s+/)
  if (source[0] !== 'git') return { kind: 'unsupported', reason: 'syntax' }
  const subcommand = words[1]
  if (subcommand === undefined) return { kind: 'unsupported', reason: 'subcommand' }
  if (subcommand.startsWith('-')) {
    const config = words.slice(1).some(word => word === '-c' || word.startsWith('-c') || word.startsWith('--config-env'))
    return { kind: 'unsupported', reason: config ? 'config' : 'global-options' }
  }
  if (source[1] !== subcommand || !/^[A-Za-z][A-Za-z0-9-]*$/.test(subcommand)) {
    return { kind: 'unsupported', reason: 'syntax' }
  }
  if (segment.subject !== segment.raw) {
    const assignments = segment.raw.slice(0, segment.raw.length - segment.subject.length)
    const assignmentWords = literalWords(assignments)
    if (assignmentWords === undefined || assignmentWords.some(word => word.startsWith('GIT_'))) {
      return { kind: 'unsupported', reason: 'config' }
    }
    if (subcommand === 'commit' || subcommand === 'push') return { kind: 'unsupported', reason: 'assignment' }
  }
  return { kind: 'git', subcommand, args: words.slice(2) }
}
