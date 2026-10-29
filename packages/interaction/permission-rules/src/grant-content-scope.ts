/**
 * contentScope verification (design §3.6): before a git commit/push escalation
 * is auto-approved, the host checks — through DIRECT git spawns, never the
 * shell service — that the change set is tracked markdown only.
 *
 * Class rules (§3.6, G-12 forms): `M`/`A` require a `.md`/`.mdx` path; `R`
 * (and `C`) are judged by their NEW path; `D` and every non-md path violate;
 * unrecognized status letters violate (fail closed). An empty set passes (an
 * idempotent push is legitimate).
 *
 * @module @dsh-cc/permission-rules/grant-content-scope
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { splitShellCommand, type ShellSegment } from './shell-segments.ts'

const run = promisify(execFile)

/**
 * Run one git command against a workspace root, directly (the approval
 * listener must never re-enter the shell service). Injectable for tests.
 */
export type GitRunner = (root: string, args: readonly string[]) => Promise<string>

/** The production runner: `git -C <root> <args…>` with stdout as text. */
export const spawnGit: GitRunner = async (root, args) => {
  const { stdout } = await run('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024 })
  return String(stdout)
}

/**
 * Run one git command and return its trimmed single-line output (the branch
 * guard uses this).
 * @param root - the workspace root.
 * @param args - the git argv (after `-C root`).
 * @param git - the runner (injected in tests).
 * @returns the trimmed stdout.
 */
export async function gitLine(root: string, args: readonly string[], git: GitRunner = spawnGit): Promise<string> {
  return (await git(root, args)).trim()
}

/** One parsed `--name-status -z` entry. */
export interface NameStatusEntry {
  /** The raw status token (`M`, `A`, `D`, `R100`, …). */
  readonly status: string
  /** The path the entry is judged by (the NEW path for rename/copy). */
  readonly path: string
}

/**
 * Parse `git … --name-status -z` output: NUL-separated, a status token then
 * its path, with rename/copy carrying old then new path.
 * @param text - the raw `-z` output.
 * @returns the entries in output order.
 */
export function parseNameStatusZ(text: string): NameStatusEntry[] {
  const tokens = text.split('\0').filter(token => token !== '')
  const entries: NameStatusEntry[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index] as string
    const letter = status[0] ?? ''
    // A non-status token means the output shape drifted: keep it as a
    // fail-closed entry so verification never silently passes.
    if (!/^[A-Z][0-9]*$/.test(status)) {
      entries.push({ status: '?', path: status })
      continue
    }
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[index + 1]
      const newPath = tokens[index + 2]
      if (oldPath === undefined || newPath === undefined) {
        entries.push({ status: '?', path: status })
        break
      }
      entries.push({ status, path: newPath })
      index += 2
      continue
    }
    const path = tokens[index + 1]
    if (path === undefined) {
      entries.push({ status: '?', path: status })
      break
    }
    entries.push({ status, path })
    index += 1
  }
  return entries
}

/** Whether a path ends in the markdown scope (`.md` / `.mdx`). */
function isMarkdown(path: string): boolean {
  return /\.mdx?$/.test(path)
}

/**
 * The §3.6 class rules over a parsed change set.
 * @param entries - parsed `--name-status -z` entries.
 * @returns one human-readable line per violating entry; empty = in scope.
 */
export function contentScopeViolations(entries: readonly NameStatusEntry[]): string[] {
  const violations: string[] = []
  for (const entry of entries) {
    const letter = entry.status[0] ?? ''
    if (letter === 'M' || letter === 'A') {
      if (!isMarkdown(entry.path)) violations.push(`${entry.status} ${entry.path} is not markdown`)
      continue
    }
    if (letter === 'R' || letter === 'C') {
      if (!isMarkdown(entry.path)) violations.push(`${entry.status} ${entry.path} is not markdown`)
      continue
    }
    if (letter === 'D') {
      violations.push(`D ${entry.path} deletes a tracked file`)
      continue
    }
    violations.push(`${entry.status || '?'} ${entry.path} is outside the markdown-only scope`)
  }
  return violations
}

/** The pre-commit check: the staged change set must be tracked markdown only. */
export async function commitScopeViolations(root: string, git: GitRunner = spawnGit): Promise<string[]> {
  return contentScopeViolations(parseNameStatusZ(await git(root, ['diff', '--cached', '-z', '--name-status'])))
}

/** The post-hoc `git commit -a` check: the commit's own change set. */
export async function commitPostHocViolations(root: string, git: GitRunner = spawnGit): Promise<string[]> {
  return contentScopeViolations(parseNameStatusZ(
    await git(root, ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', 'HEAD']),
  ))
}

/** The push check: everything `origin/<branch>..HEAD` would publish. */
export async function pushScopeViolations(
  root: string,
  branch: string,
  git: GitRunner = spawnGit,
): Promise<string[]> {
  // `--format=` suppresses the per-commit headers so `-z --name-status` yields
  // exactly the change set the range carries (headers would parse as statuses).
  return contentScopeViolations(parseNameStatusZ(
    await git(root, ['log', '--format=', '-z', '--name-status', `origin/${branch}..HEAD`]),
  ))
}

/**
 * The top-level segments of a command, or undefined when the command cannot be
 * segmented. A grant only ever admits segmented commands, so an opaque text is
 * treated as "may contain anything" and fails closed.
 */
function segmentsOf(command: string): readonly ShellSegment[] | undefined {
  const result = splitShellCommand(command)
  return result.kind === 'segments' ? result.segments : undefined
}

/** The whitespace tokens of one segment's subject. */
function segmentTokens(segment: ShellSegment): string[] {
  return segment.subject.trim().split(/\s+/).filter(token => token !== '')
}

/**
 * Whether ANY top-level segment invokes `git <subcommand>` (the subcommand is
 * the very next token — `git stash push` is NOT `git push`). A compound such as
 * `echo x && git commit -a` is detected by its commit segment.
 */
function anyGitSubcommand(command: string, subcommand: string): boolean {
  const segments = segmentsOf(command)
  if (segments === undefined) return true
  return segments.some(segment => {
    const tokens = segmentTokens(segment)
    return tokens[0] === 'git' && tokens[1] === subcommand
  })
}

/** Whether a command text invokes `git commit` in any segment (any flag order). */
export function isCommitCommand(command: string): boolean {
  return anyGitSubcommand(command, 'commit')
}

/** Whether a command text invokes `git push` in any segment. */
export function isPushCommand(command: string): boolean {
  return anyGitSubcommand(command, 'push')
}

/** The `git commit` segments of a command. */
function commitSegments(command: string): readonly ShellSegment[] {
  const segments = segmentsOf(command)
  if (segments === undefined) return []
  return segments.filter(segment => {
    const tokens = segmentTokens(segment)
    return tokens[0] === 'git' && tokens[1] === 'commit'
  })
}

/** Whether any commit segment carries `-a`/`--all` (including `-am`). */
export function stagesAtCommit(command: string): boolean {
  const segments = segmentsOf(command)
  if (segments === undefined) return isCommitCommand(command)
  return commitSegments(command).some(segment =>
    segmentTokens(segment).some(token =>
      token === '--all' || (/^-[A-Za-z]+$/.test(token) && token.includes('a'))))
}
