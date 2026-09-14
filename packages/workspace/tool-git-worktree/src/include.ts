/**
 * WS-6 `.worktreeinclude` support (§6 item 1): a minimal gitignore-subset
 * matcher (comments, `!` negation, trailing `/`, `*`, `?`, `**`) plus CC's
 * `**` + `/`-piercing rule, and the copy step that materializes matched AND
 * `git check-ignore`-confirmed files into a newly created worktree.
 * Tool-side only — the launcher's pre-build JS deliberately does not clone
 * this (a parser, not a command string; recorded manifest deviation).
 * @module @dsh-cc/tool-git-worktree/include
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { quote } from './worktree.ts'

/** One parsed pattern line. */
interface IncludePattern {
  re: RegExp
  /** Pattern carried a trailing `/` (matches directories only). */
  dirOnly: boolean
  /** Pattern carried a leading `!` (last match wins, gitignore semantics). */
  negated: boolean
  /** Pattern began with `**` + `/` — subject to CC's piercing rule. */
  globstar: boolean
  /** First literal segment after a leading `**` + `/` (piercing-rule subject). */
  firstLiteral: string | undefined
}

function escapeRe(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

/** One non-`**` pattern segment: `*` and `?` never cross `/`. */
function segmentRe(seg: string): string {
  return escapeRe(seg).replaceAll('*', '[^/]*').replaceAll('?', '[^/]')
}

/**
 * Convert one pattern to a regex over a POSIX-style relative path. `**` as a
 * full middle segment matches zero or more whole directories; a leading `**` + `/`
 * makes the pattern match at any depth; a a trailing `**` matches everything
 * below.
 */
function parsePattern(raw: string): IncludePattern | undefined {
  let p = raw.trim()
  if (p.length === 0 || p.startsWith('#')) return undefined
  const negated = p.startsWith('!')
  if (negated) p = p.slice(1)
  const dirOnly = p.endsWith('/')
  if (dirOnly) p = p.slice(0, -1)
  const globstar = p.startsWith('**/')
  // A pattern containing a `/` (after the trailing strip) is anchored —
  // except a leading `**` + `/`, which matches at any depth (git + CC).
  const anchored = p.includes('/') && !globstar
  if (p.startsWith('/')) p = p.slice(1)
  const segs = p.split('/')
  // Leading `**` + `/`: the following segment is the piercing-rule subject
  // when literal; the leading `**` itself is covered by the unanchored prefix.
  const rest = globstar ? segs.slice(1) : segs
  const head = rest[0]
  const firstLiteral = globstar && head !== undefined && head !== '**' && !/[*?]/.test(head)
    ? head
    : undefined
  const parts: string[] = []
  // When the pattern began with `**` + `/`, the body is built from the rest —
  // the any-depth behavior is the unanchored prefix, not a leading `.*`+`/`.
  const bodySegs = globstar ? rest : segs
  bodySegs.forEach((seg, i) => {
    if (seg === '**' && i > 0 && i < bodySegs.length - 1) {
      // A middle `**` spans zero or more whole directories (it swallows the
      // following separator), e.g. a/**/b matches a/b and a/x/y/b.
      parts.push('(?:[^/]+/)*')
      return
    }
    parts.push(seg === '**' ? '.*' : segmentRe(seg))
    if (i < bodySegs.length - 1) parts.push('/')
  })
  const re = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${parts.join('')}$`)
  return { re, dirOnly, negated, globstar, firstLiteral }
}

function patternMatches(pattern: IncludePattern, relPath: string, isDir: boolean): boolean {
  if (pattern.dirOnly && !isDir) return false
  return pattern.re.test(relPath)
}

/**
 * Does any ancestor directory of `relPath` match the pattern (as a directory)?
 * The first clause of CC's piercing rule.
 */
function anyAncestorMatches(pattern: IncludePattern, relPath: string): boolean {
  const segs = relPath.split('/')
  for (let i = 1; i < segs.length; i += 1) {
    if (patternMatches(pattern, segs.slice(0, i).join('/'), true)) return true
  }
  return false
}

/**
 * CC's `**` + `/`-piercing rule: a `**`/foo pattern matches a file inside a
 * wholly-ignored directory only when the directory itself matches the pattern
 * or the path's first name equals the pattern's first literal segment.
 */
function piercingAllows(pattern: IncludePattern, relPath: string, ancestorIgnored: boolean): boolean {
  if (!pattern.globstar || !ancestorIgnored) return true
  if (anyAncestorMatches(pattern, relPath)) return true
  return pattern.firstLiteral !== undefined && relPath.split('/')[0] === pattern.firstLiteral
}

/**
 * Last-match-wins gitignore evaluation over the raw pattern lines.
 * @param patterns - Raw `.worktreeinclude` lines.
 * @param relPath - POSIX-style relative path to test.
 * @param opts - `isDir` for directory matching; `ancestorIgnored` feeds the
 *   `**` + `/`-piercing rule (a file under a wholly-ignored directory).
 * @returns true when the path is finally included.
 */
export function includeMatches(
  patterns: string[],
  relPath: string,
  opts: { isDir?: boolean; ancestorIgnored?: boolean } = {},
): boolean {
  let included = false
  const isDir = opts.isDir ?? false
  for (const raw of patterns) {
    const pattern = parsePattern(raw)
    if (pattern === undefined) continue
    const direct = patternMatches(pattern, relPath, isDir)
    // A wholly-ignored directory the pattern matches pulls its whole subtree
    // in (gitignore semantics) — including a dirOnly pattern's directory.
    const viaAncestor = !isDir && opts.ancestorIgnored === true && !pattern.negated
      && !direct && anyAncestorMatches(pattern, relPath)
    if (direct || viaAncestor) {
      included = pattern.negated
        ? false
        : direct && opts.ancestorIgnored === true
          ? piercingAllows(pattern, relPath, true)
          : true
    }
  }
  return included
}

/** Split `.worktreeinclude` text into pattern lines (comments and blanks dropped). */
export function parseWorktreeInclude(text: string): string[] {
  return text.split(/\r?\n/).filter(line => line.trim().length > 0 && !line.trim().startsWith('#'))
}

/** Injectable shell plumbing for {@link copyIncludedFiles}: run one command string. */
export interface IncludeGit {
  /** Run `command` at `workdir`; `undefined` means spawn failure. */
  (command: string, workdir: string): Promise<{ status: number | null; stdout: string } | undefined>
}

/** NUL-split stdout of `-z` plumbing. */
function nulEntries(stdout: string): string[] {
  return stdout.split('\0').filter(entry => entry.length > 0)
}

/**
 * Copy every `.worktreeinclude`-matched AND gitignored file from `mainRoot`
 * into `worktreePath`, preserving relative paths. Candidates are enumerated
 * with `git ls-files --others --ignored --exclude-standard -z` (only
 * gitignored files can be copied), confirmed in one batch
 * `git check-ignore -z --stdin`, filtered through the piercing rule using a
 * second batch over parent directories, and copied with plain fs.
 * @returns the copied relative paths, in match order.
 */
export async function copyIncludedFiles(
  mainRoot: string,
  worktreePath: string,
  git: IncludeGit,
): Promise<string[]> {
  const includeFile = join(mainRoot, '.worktreeinclude')
  if (!existsSync(includeFile)) return []
  let text: string
  try {
    text = readFileSync(includeFile, 'utf8')
  } catch {
    return []
  }
  const patterns = parseWorktreeInclude(text)
  if (patterns.length === 0) return []

  const listed = await git('git ls-files --others --ignored --exclude-standard -z', mainRoot)
  if (listed === undefined || listed.status !== 0) return []
  const candidates = nulEntries(listed.stdout)
  if (candidates.length === 0) return []

  // First batch: which candidates git itself considers ignored.
  const confirmed = await checkIgnoreBatch(candidates, mainRoot, git)

  // Second batch: which parents are themselves ignored (the piercing rule's
  // "wholly-ignored directory" condition, and the dir-matched-subtree rule).
  const parents = new Set<string>()
  for (const rel of confirmed) {
    const segs = rel.split('/')
    for (let i = 1; i < segs.length; i += 1) parents.add(segs.slice(0, i).join('/'))
  }
  const ignoredParents = new Set(await checkIgnoreBatch([...parents], mainRoot, git))

  const copied: string[] = []
  for (const rel of confirmed) {
    const segs = rel.split('/')
    const ancestorIgnored = segs.slice(0, -1).some((_, i) => ignoredParents.has(segs.slice(0, i + 1).join('/')))
    if (!includeMatches(patterns, rel, { ancestorIgnored })) continue
    const target = join(worktreePath, rel)
    try {
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(join(mainRoot, rel), target)
      copied.push(rel)
    } catch {
      // A single unreadable file must not fail worktree creation.
    }
  }
  return copied
}

/** One batched `git check-ignore -z --stdin` over `paths`; returns the ignored subset. */
async function checkIgnoreBatch(paths: string[], workdir: string, git: IncludeGit): Promise<string[]> {
  if (paths.length === 0) return []
  const command = `printf '%s\\0' ${paths.map(quote).join(' ')} | git check-ignore -z --stdin --`
  const result = await git(command, workdir)
  if (result === undefined || (result.status !== 0 && result.status !== 1)) return []
  return nulEntries(result.stdout)
}
