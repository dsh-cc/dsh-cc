/**
 * TUI autocomplete provider: slash-command suggestions + `@`-file completion.
 * Implements pi-tui's `AutocompleteProvider` interface so the vendored Editor
 * can drive it via `setAutocompleteProvider`. Slash suggestions come from an
 * injected command catalog (local + harness); `@`-paths come from OUR OWN
 * workspace walk (recursive readdir, no `fd` dependency).
 * @module @dsh-cc/tui/components/completion
 */

import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from '@dsh-cc/pi-tui'
import { fuzzyFilter } from '@dsh-cc/pi-tui'

/** A command in the injected catalog. */
export interface CommandItem {
  readonly name: string
  readonly description?: string
  readonly argumentHint?: string
}

/** A workspace walk returns relative POSIX paths (no leading ./). */
export type WorkspaceWalk = (cwd: string, signal: AbortSignal) => string[]

/**
 * Per-command argument completer: given the current argument word (may be
 * empty) and the request's AbortSignal, return candidate items. The provider
 * prefix-filters the returned values against the argument word, so a completer
 * may return the full candidate list and let the provider narrow it.
 */
export type ArgCompleter = (
  prefix: string,
  signal: AbortSignal,
) => AutocompleteItem[] | Promise<AutocompleteItem[]>

/** Argument completers keyed by slash-command name (lowercase). */
export type ArgCompleterMap = Readonly<Record<string, ArgCompleter>>

const MAX_WALK_RESULTS = 200
const MAX_WALK_DEPTH = 8

/** Directory names pruned from the walk unconditionally. */
const PRUNED_DIRS = new Set(['.git', 'node_modules'])

/**
 * Path delimiters that bound a token. Mirrors pi-tui's PATH_DELIMITERS so token
 * extraction is consistent with the vendored provider's expectations.
 */
const TOKEN_DELIMITERS = new Set([' ', '\t', '"', "'", '='])

function isPathDelimiter(ch: string | undefined): boolean {
  return ch !== undefined && TOKEN_DELIMITERS.has(ch)
}

function toPosix(p: string): string {
  return p.split(sep).join('/')
}

/** Find the start of the token (after the last path/space delimiter). */
function tokenStart(text: string): number {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (isPathDelimiter(text[i])) return i + 1
  }
  return 0
}

/**
 * Recursive readdir walk from `cwd`, returning relative POSIX paths.
 * Directory entries carry a trailing '/'. Prunes `.git` and `node_modules`;
 * caps depth at {@link MAX_WALK_DEPTH} and total results at
 * {@link MAX_WALK_RESULTS}. Honors the AbortSignal between directories.
 * Dotfiles are included only when the user has already typed a leading dot in
 * the prefix (so `@.` surfaces them but `@src` does not).
 */
function defaultWalk(cwd: string, signal: AbortSignal): string[] {
  const results: string[] = []

  const walk = (dir: string, depth: number): void => {
    if (signal.aborted) return
    if (results.length >= MAX_WALK_RESULTS) return
    if (depth > MAX_WALK_DEPTH) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (signal.aborted) return
      if (results.length >= MAX_WALK_RESULTS) return
      if (PRUNED_DIRS.has(entry.name)) continue
      const full = join(dir, entry.name)
      const rel = toPosix(relative(cwd, full))
      if (entry.isDirectory()) {
        results.push(`${rel}/`)
        walk(full, depth + 1)
      } else if (entry.isSymbolicLink()) {
        // Resolve the symlink target to classify dir-vs-file; follow with a
        // guard against broken links (treat as a file if unreadable).
        try {
          if (statSync(full).isDirectory()) {
            results.push(`${rel}/`)
          } else {
            results.push(rel)
          }
        } catch {
          results.push(rel)
        }
      } else {
        results.push(rel)
      }
    }
  }

  walk(cwd, 0)
  return results
}

/**
 * Filter a walk tree down to entries whose relative path starts with the given
 * prefix (case-insensitive on the path, segment-aware). Directory entries are
 * indicated by a trailing '/'. Returns AutocompleteItem values: directories
 * keep the trailing '/' in both value and label; files get a trailing space
 * via applyCompletion (not here). Directories sort before files.
 */
function buildPathItems(
  tree: readonly string[],
  rawPrefix: string,
  isAtPrefix: boolean,
): AutocompleteItem[] {
  const prefixLower = rawPrefix.toLowerCase()
  const matched: { rel: string; isDir: boolean; name: string }[] = []
  for (const rel of tree) {
    const posixRel = rel.replace(/\\/g, '/')
    if (!posixRel.toLowerCase().startsWith(prefixLower)) continue
    const isDir = posixRel.endsWith('/')
    const clean = isDir ? posixRel.slice(0, -1) : posixRel
    const name = clean.split('/').pop() ?? clean
    matched.push({ rel: posixRel, isDir, name })
  }
  matched.sort((a, b) => {
    if (a.isDir && !b.isDir) return -1
    if (!a.isDir && b.isDir) return 1
    return a.rel.localeCompare(b.rel)
  })
  return matched.slice(0, MAX_WALK_RESULTS).map(({ rel, isDir, name }) => {
    const pathValue = isDir ? rel : rel // dir already has trailing '/'
    return {
      value: isAtPrefix ? `@${pathValue}` : pathValue,
      label: isDir ? `${name}/` : name,
      description: isDir ? rel.slice(0, -1) : rel,
    }
  })
}

/**
 * Autocomplete provider for the TUI composer. Handles `/command` suggestions
 * (prefix-filtered from an injected catalog) and `@file` completion (fuzzy
 * prefix match against a workspace walk rooted at `cwd`).
 */
export class TuiAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters = ['/', '@']

  private readonly commands: readonly CommandItem[]
  private readonly cwd: string
  private readonly walk: WorkspaceWalk
  private readonly argCompleters: ArgCompleterMap

  constructor(
    commands: readonly CommandItem[],
    cwd: string,
    walk: WorkspaceWalk = defaultWalk,
    argCompleters: ArgCompleterMap = {},
  ) {
    this.commands = commands
    this.cwd = cwd
    this.walk = walk
    this.argCompleters = argCompleters
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const currentLine = lines[cursorLine] ?? ''
    const before = currentLine.slice(0, cursorCol)

    // --- @-file completion -------------------------------------------------
    const start = tokenStart(before)
    const token = before.slice(start)
    if (token.startsWith('@')) {
      const rawPrefix = token.slice(1) // strip '@'
      // The walk itself honors the signal; call it even when already aborted so
      // the provider reports a clean null (and tests can observe the call).
      const tree = this.walk(this.cwd, options.signal)
      if (options.signal.aborted) return null
      const items = buildPathItems(tree, rawPrefix, true)
      if (items.length === 0) return null
      return { items, prefix: token }
    }

    // --- /command completion ----------------------------------------------
    // Only at the start of the first line, with no space yet.
    if (cursorLine === 0 && before.startsWith('/') && !before.includes(' ')) {
      const cmdPrefix = before.slice(1)
      const filtered = fuzzyFilter(
        this.commands.map(c => ({ name: c.name, description: c.description, argumentHint: c.argumentHint })),
        cmdPrefix,
        c => c.name,
      )
      const items: AutocompleteItem[] = filtered.map(c => {
        const hint = c.argumentHint
        const desc = c.description ?? ''
        const fullDesc = hint ? (desc ? `${hint} — ${desc}` : hint) : desc
        return {
          value: c.name,
          label: c.name,
          ...fullDesc.length === 0 ? {} : { description: fullDesc },
        }
      })
      if (items.length === 0) return null
      return { items, prefix: before }
    }

    // --- /command argument completion --------------------------------------
    // The editor's trigger pattern requires the trigger token to end the line,
    // so it never fires once a space follows the command — argument suggestions
    // are reachable only through explicit Tab. Dispatch to the per-command
    // completer when one is registered; without one, stay at null (argument
    // territory keeps the pre-completion behavior). An argument token starting
    // with '@' never reaches here: the @-file branch above wins by design.
    if (cursorLine === 0) {
      const argMatch = /^\/(\S+)\s(.*)$/.exec(before)
      if (argMatch !== null) {
        const completer = this.argCompleters[argMatch[1]!.toLowerCase()]
        if (completer === undefined) return null
        const args = argMatch[2]!
        const argPrefix = args.slice(tokenStart(args))
        const candidates = await completer(argPrefix, options.signal)
        if (options.signal.aborted) return null
        const prefixLower = argPrefix.toLowerCase()
        const items = candidates.filter(item => item.value.toLowerCase().startsWith(prefixLower))
        if (items.length === 0) return null
        return { items, prefix: argPrefix }
      }
    }

    return null
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const currentLine = lines[cursorLine] ?? ''
    const beforePrefix = currentLine.slice(0, cursorCol - prefix.length)
    const afterCursor = currentLine.slice(cursorCol)

    // Slash command: replace `/partial` with `/name` + a separating space
    // (but only if the text after the cursor doesn't already begin with one,
    // to avoid doubling spaces when completing mid-line).
    if (prefix.startsWith('/') && beforePrefix.trim() === '') {
      const separator = afterCursor.startsWith(' ') || afterCursor.startsWith('\t') ? '' : ' '
      const newLine = `${beforePrefix}/${item.value}${separator}${afterCursor}`
      const newLines = [...lines]
      newLines[cursorLine] = newLine
      return {
        lines: newLines,
        cursorLine,
        cursorCol: beforePrefix.length + 1 + item.value.length + separator.length, // +1 for '/'
      }
    }

    // @-file: replace `@partial` with `@relpath` (+ trailing '/' kept open for dirs,
    // + trailing space for files).
    if (prefix.startsWith('@')) {
      const isDir = item.label.endsWith('/')
      const suffix = isDir ? '' : ' '
      const newLine = `${beforePrefix}${item.value}${suffix}${afterCursor}`
      const newLines = [...lines]
      newLines[cursorLine] = newLine
      return {
        lines: newLines,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + suffix.length,
      }
    }

    // Slash-command argument: replace only the current argument word, keeping
    // the command name and everything before it intact. The prefix is exactly
    // the word being replaced (see the argument branch in getSuggestions), so
    // the generic before/after slicing already preserves the command; only the
    // separator differs from plain insertion.
    if (cursorLine === 0 && currentLine.startsWith('/') && beforePrefix.includes(' ')) {
      const separator = afterCursor.startsWith(' ') || afterCursor.startsWith('\t') ? '' : ' '
      const newLine = `${beforePrefix}${item.value}${separator}${afterCursor}`
      const newLines = [...lines]
      newLines[cursorLine] = newLine
      return {
        lines: newLines,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + separator.length,
      }
    }

    // Fallback: plain insertion.
    const newLine = `${beforePrefix}${item.value}${afterCursor}`
    const newLines = [...lines]
    newLines[cursorLine] = newLine
    return {
      lines: newLines,
      cursorLine,
      cursorCol: beforePrefix.length + item.value.length,
    }
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    const currentLine = lines[cursorLine] ?? ''
    const before = currentLine.slice(0, cursorCol)
    // Don't force-trigger while typing a slash command at the start of a line.
    if (before.trimStart().startsWith('/') && !before.trimStart().includes(' ')) {
      return false
    }
    return true
  }
}
