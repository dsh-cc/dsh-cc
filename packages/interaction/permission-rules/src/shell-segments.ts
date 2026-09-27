/**
 * Shell command segmentation (design doc D1): one linear scan splits a bash
 * command into top-level segments so a content rule only ever matches ONE
 * complete segment. The scanner is O(command.length), uses no regex over the
 * command body, and never throws — anything it cannot confidently segment
 * (unterminated quotes, heredocs, subshells, groups, reserved words, too many
 * segments) comes back `opaque` and the evaluator fail-closes content allows.
 * @module @dsh-cc/permission-rules/shell-segments
 */

/** One top-level shell segment (trimmed, continuations applied). */
export type ShellSegment = {
  /** Trimmed top-level source slice, continuations applied. */
  readonly raw: string
  /** `raw` minus leading assignment words, trimmed. */
  readonly subject: string
  /** First whitespace token of `subject` (quotes consumed). */
  readonly first: string
  /** Command substitution or a writing redirection inside this segment. */
  readonly tainted: boolean
  /** The segment is nothing but leading assignments (`H=/tmp/x` alone). */
  readonly assignmentOnly: boolean
}

/** Why a command could not be segmented into trustworthy segments. */
export type OpaqueWhy =
  | 'quote'
  | 'grammar'
  | 'heredoc'
  | 'subshell'
  | 'group'
  | 'reserved'
  | 'too-many'

/** Either the command's top-level segments (≥1) or the reason it is opaque. */
export type SegmentResult =
  | { readonly kind: 'segments'; readonly segments: readonly ShellSegment[] }
  | { readonly kind: 'opaque'; readonly why: OpaqueWhy }

/** Maximum number of segments a command may yield before going opaque. */
const MAX_SEGMENTS = 64

/** Reserved words whose leading presence makes a segment opaque (D1). */
import { firstShellToken, stripLeadingAssignments, type QuoteState } from './shell-words.ts'

const RESERVED_WORDS = new Set([
  'if', 'then', 'elif', 'else', 'fi', 'for', 'select', 'while', 'until', 'do',
  'done', 'case', 'in', 'esac', 'function', 'time', 'coproc', '!', '[[', ']]',
])


/**
 * One lexical frame: the top level, a `$( … )`/backquote substitution, or the
 * inside of `${ … }` is a depth on the enclosing frame. Substitution frames
 * carry their own quote state so nested quotes never leak out.
 */
type Frame = {
  kind: 'top' | 'subst' | 'backtick'
  quote: QuoteState
  /** Balanced `${ … }` depth inside this frame. */
  param: number
  /** Nested `(` group depth inside a substitution frame. */
  paren: number
}

type ScanResult = { segments: ShellSegment[] } | { why: OpaqueWhy }

/**
 * Split a bash command into its top-level segments (D1). Linear scan, no
 * regex over the command body, never throws: an unexpected internal error
 * degrades to `opaque:'grammar'` rather than propagating.
 * @param command - the raw shell command text.
 * @returns the segments, or why the command is opaque.
 */
export function splitShellCommand(command: string): SegmentResult {
  try {
    const scan = scanSegments(command)
    return 'segments' in scan
      ? { kind: 'segments', segments: scan.segments }
      : { kind: 'opaque', why: scan.why }
  } catch {
    return { kind: 'opaque', why: 'grammar' }
  }
}


/** The one-pass scanner proper: returns segments or an opacity reason. */
function scanSegments(command: string): ScanResult {
  const segments: ShellSegment[] = []
  let segmentText = ''
  let tainted = false
  let pendingBinary = false
  const frames: Frame[] = [{ kind: 'top', quote: 'none', param: 0, paren: 0 }]
  const top = (): Frame => frames[frames.length - 1]!

  const flush = (): OpaqueWhy | undefined => {
    const text = segmentText.trim()
    if (text === '') return undefined
    if (segments.length >= MAX_SEGMENTS) return 'too-many'
    const subject = stripLeadingAssignments(text)
    const first = firstShellToken(subject)
    if (subject !== '' && RESERVED_WORDS.has(first)) return 'reserved'
    segments.push({
      raw: text,
      subject,
      first,
      tainted,
      assignmentOnly: subject === '',
    })
    segmentText = ''
    tainted = false
    return undefined
  }

  let index = 0
  while (index < command.length) {
    const frame = top()
    const char = command[index]
    if (frame.quote === 'ansi') {
      if (char === '\\' && index + 1 < command.length) {
        segmentText += char + command[index + 1]
        index += 2
        continue
      }
      if (char === "'") frame.quote = 'none'
      segmentText += char
      index += 1
      continue
    }
    if (frame.quote === 'single') {
      if (char === "'") frame.quote = 'none'
      segmentText += char
      index += 1
      continue
    }
    if (frame.quote === 'double') {
      if (char === '\\' && index + 1 < command.length) {
        const next = command[index + 1]
        if (next === '"' || next === '\\' || next === '`' || next === '$') {
          segmentText += char + next
          index += 2
          continue
        }
        if (next === '\n') {
          index += 2
          continue
        }
        segmentText += char
        index += 1
        continue
      }
      if (char === '"') frame.quote = 'none'
      else if (char === '`') {
        // Command substitution executes inside double quotes — taints.
        tainted = true
        frames.push({ kind: 'backtick', quote: 'none', param: 0, paren: 0 })
      } else if (char === '$' && command[index + 1] === '(') {
        tainted = true
        frames.push({ kind: 'subst', quote: 'none', param: 0, paren: 0 })
        segmentText += '$('
        index += 2
        continue
      } else if (char === '$' && command[index + 1] === '{') {
        frame.param += 1
        segmentText += '${'
        index += 2
        continue
      } else if (char === '}' && frame.param > 0) {
        // The closing brace of a `${…}` expansion is balanced even inside
        // double quotes.
        frame.param -= 1
      }
      segmentText += char
      index += 1
      continue
    }
    // Unquoted (in any frame kind):
    if (char === '\\') {
      const next = command[index + 1]
      if (next === undefined) return { why: 'quote' }
      if (next === '\n') {
        index += 2
        continue
      }
      segmentText += char + next
      index += 2
      continue
    }
    if (char === "'" || char === '"') {
      frame.quote = char === "'" ? 'single' : 'double'
      segmentText += char
      index += 1
      continue
    }
    if (char === '$' && command[index + 1] === "'") {
      frame.quote = 'ansi'
      segmentText += "$'"
      index += 2
      continue
    }
    if (char === '$' && command[index + 1] === '(') {
      tainted = true
      frames.push({ kind: 'subst', quote: 'none', param: 0, paren: 0 })
      segmentText += '$('
      index += 2
      continue
    }
    if (char === '$' && command[index + 1] === '{') {
      frame.param += 1
      segmentText += '${'
      index += 2
      continue
    }
    if (char === '`') {
      if (frame.kind === 'backtick') {
        // A backquote inside a backquote substitution CLOSES it.
        frames.pop()
        segmentText += char
        index += 1
        continue
      }
      tainted = true
      frames.push({ kind: 'backtick', quote: 'none', param: 0, paren: 0 })
      segmentText += char
      index += 1
      continue
    }
    if (char === '}') {
      if (frame.param > 0) {
        frame.param -= 1
        segmentText += char
        index += 1
        continue
      }
      return { why: 'group' }
    }
    if (char === '{') {
      if (frame.param === 0) return { why: 'group' }
      segmentText += char
      index += 1
      continue
    }
    if (char === '(') {
      if (frame.kind === 'top') return { why: 'subshell' }
      frame.paren += 1
      segmentText += char
      index += 1
      continue
    }
    if (char === ')') {
      if (frame.kind === 'top') return { why: 'subshell' }
      if (frame.kind === 'backtick' && frame.paren === 0) {
        segmentText += char
        index += 1
        continue
      }
      if (frame.paren > 0) frame.paren -= 1
      else frames.pop()
      segmentText += char
      index += 1
      continue
    }
    if (char === '>' || char === '<') {
      const redirect = readRedirect(command, index)
      if (redirect.kind === 'heredoc') return { why: 'heredoc' }
      if (redirect.kind === 'taint') tainted = true
      segmentText += redirect.text
      index += redirect.length
      continue
    }
    if (frame.kind === 'top') {
      const separated = separatorAction(command, index)
      if (separated !== undefined) {
        if (separated.action === 'split') {
          const hadText = segmentText.trim() !== ''
          const flushed = flush()
          if (flushed !== undefined) return { why: flushed }
          // Operand integrity: `&&`/`||`/`|`/`|&` need a left operand; `;`
          // and `&` may terminate a command but may not begin one.
          if (!hadText && separated.char !== '\n') return { why: 'grammar' }
          if (separated.binary) pendingBinary = true
          else if (separated.char !== '\n' || hadText) pendingBinary = false
        }
        index = separated.next
        continue
      }
      if (char === '#' && (segmentText === '' || segmentText.endsWith(' ') || segmentText.endsWith('\t'))) {
        // Comment from word-start to end of line; the newline itself is a
        // separator handled on the next iteration.
        while (index < command.length && command[index] !== '\n') index += 1
        continue
      }
      if (char === '&' && command[index + 1] === '>') {
        // `&>` / `&>>`: a writing redirection, not backgrounding.
        tainted = true
        segmentText += '&'
        index += 1
        continue
      }
    }
    segmentText += char
    index += 1
  }

  const hadRightOperand = segmentText.trim() !== ''
  const flushed = flush()
  if (flushed !== undefined) return { why: flushed }
  if (pendingBinary && !hadRightOperand) return { why: 'grammar' }
  // Unterminated quote/substitution/parameter state ⇒ opaque (D1).
  if (frames.length > 1 || frames.some(frame => frame.quote !== 'none' || frame.param > 0)) {
    return { why: 'quote' }
  }
  if (segments.length === 0) return { why: 'grammar' }
  return { segments }
}

/** Separator classification at a top-level position, or undefined. */
function separatorAction(
  command: string,
  index: number,
): { action: 'split' | 'empty'; char: string; binary: boolean; next: number } | undefined {
  const char = command[index]
  const next = command[index + 1]
  if (char === '&' && next === '&') return { action: 'split', char: '&&', binary: true, next: index + 2 }
  if (char === '|' && next === '|') return { action: 'split', char: '||', binary: true, next: index + 2 }
  if (char === '|' && next === '&') return { action: 'split', char: '|&', binary: true, next: index + 2 }
  if (char === '|' ) return { action: 'split', char: '|', binary: true, next: index + 1 }
  if (char === ';') return { action: 'split', char: ';', binary: false, next: index + 1 }
  if (char === '&' && next !== '>') return { action: 'split', char: '&', binary: false, next: index + 1 }
  if (char === '\n') return { action: 'split', char: '\n', binary: false, next: index + 1 }
  return undefined
}

/**
 * Classify a redirection starting at `index` (a `>` or `<`, unquoted, top
 * level). Heredocs are opaque; descriptor duplication (`[n]>&m`, `[n]<&m`,
 * `>&-`…) is inert; every other redirection shape taints. A leading
 * descriptor is recognized only when the complete preceding unquoted token
 * is all digits — but either reading yields the same verdict for the dup
 * family (`2>&1` dups fd 2; in `x2>&1` the word `x2` stands and `>&1` dups
 * the default output descriptor; both inert).
 */
function readRedirect(
  command: string,
  index: number,
): { kind: 'heredoc' } | { kind: 'inert' | 'taint'; text: string; length: number } {
  const char = command[index]
  if (char === '<') {
    if (command.startsWith('<<<', index)) return { kind: 'heredoc' }
    if (command.startsWith('<<', index)) return { kind: 'heredoc' }
    if (command[index + 1] === '&') {
      const target = readDupTarget(command, index + 2)
      if (target !== undefined) return { kind: 'inert', text: command.slice(index, target), length: target - index }
      return { kind: 'taint', text: '<&', length: 2 }
    }
    return { kind: 'taint', text: '<', length: 1 }
  }
  // '>':
  if (command.startsWith('>>', index)) return { kind: 'taint', text: '>>', length: 2 }
  if (command.startsWith('>|', index)) return { kind: 'taint', text: '>|', length: 2 }
  if (command[index + 1] === '&') {
    const target = readDupTarget(command, index + 2)
    if (target !== undefined) return { kind: 'inert', text: command.slice(index, target), length: target - index }
    return { kind: 'taint', text: '>&', length: 2 }
  }
  return { kind: 'taint', text: '>', length: 1 }
}

/** The digits-or-`-` duplication target after `>&`/`<&`, or undefined. */
function readDupTarget(command: string, start: number): number | undefined {
  if (command[start] === '-') return start + 1
  let index = start
  while (index < command.length) {
    const c = command[index]
    if (c === undefined || c < '0' || c > '9') break
    index += 1
  }
  return index > start ? index : undefined
}
