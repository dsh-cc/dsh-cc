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
import { splitShellCommand } from './shell-segments.ts'
import { parseTaskGrantGitInvocation } from './task-grant-git.ts'
import { scopedCommandShapeViolations } from './grant-git-policy.ts'
import type { TaskGrant } from './task-grant.ts'

export { scopedCommandShapeViolations } from './grant-git-policy.ts'

const run = promisify(execFile)

/**
 * Run one git command against a workspace root, directly (the approval
 * listener must never re-enter the shell service). Injectable for tests.
 */
export type GitRunner = (root: string, args: readonly string[]) => Promise<string>

/** The production runner: `git -C <root> <args…>` with stdout as text. */
export const spawnGit: GitRunner = async (root, args) => {
  const { stdout } = await run('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024, timeout: 15000 })
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

/** The pre-commit check inspects the actual cached set; pathspec commits are refused. */
export async function commitScopeViolations(root: string, git: GitRunner = spawnGit): Promise<string[]> {
  return contentScopeViolations(parseNameStatusZ(await git(root, [
    'diff', '--cached', '--no-ext-diff', '--no-textconv', '--find-renames', '-z', '--name-status',
  ])))
}

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

/** Resolve a commit to an exact object ID, rejecting malformed runner output. */
async function commitOid(root: string, revision: string, git: GitRunner): Promise<string> {
  const oid = await gitLine(root, ['rev-parse', '--verify', `${revision}^{commit}`], git)
  if (!OID.test(oid)) throw new Error('Git did not return a valid commit object ID')
  return oid
}

/** Snapshot HEAD; null is accepted only for a verified unborn branch. */
export async function snapshotCommitHead(root: string, git: GitRunner = spawnGit): Promise<string | null> {
  try {
    return await commitOid(root, 'HEAD', git)
  } catch (error) {
    const ref = await gitLine(root, ['symbolic-ref', '--quiet', 'HEAD'], git)
    if (!ref.startsWith('refs/heads/')) throw error
    const existing = await gitLine(root, ['for-each-ref', '--format=%(objectname)', ref], git)
    if (existing !== '') throw error
    return null
  }
}

/** Check every newly reachable commit, including root trees and every merge parent. */
export async function commitRangeScopeViolations(
  root: string, before: string | null, after: string, git: GitRunner = spawnGit,
): Promise<string[]> {
  if (!OID.test(after) || (before !== null && !OID.test(before))) throw new Error('commit range requires exact object IDs')
  const end = await commitOid(root, after, git)
  const start = before === null ? null : await commitOid(root, before, git)
  const history = await git(root, ['rev-list', '--parents', end, ...start === null ? [] : ['--not', start]])
  const violations: string[] = []
  for (const line of history.trim().split('\n').filter(Boolean)) {
    const [oid, ...parents] = line.split(' ')
    if (oid === undefined || ![oid, ...parents].every(value => OID.test(value))) throw new Error('malformed Git commit graph')
    const options = ['--no-commit-id', '--name-status', '--no-ext-diff', '--no-textconv', '--find-renames', '-r', '-z']
    // Default git log omits merge diffs; explicitly compare every parent instead.
    for (const parent of parents.length === 0 ? [null] : parents) {
      const args = parent === null
        ? ['diff-tree', '--root', ...options, oid]
        : ['diff-tree', ...options, parent, oid]
      violations.push(...contentScopeViolations(parseNameStatusZ(await git(root, args))))
    }
  }
  return [...new Set(violations)]
}

/** Legacy single-commit check, including root and merge commits. Prefer a pinned range. */
export async function commitPostHocViolations(root: string, git: GitRunner = spawnGit): Promise<string[]> {
  const head = await commitOid(root, 'HEAD', git)
  const parents = (await gitLine(root, ['rev-list', '--parents', '-n', '1', head], git)).split(' ')
  if (parents[0] !== head || !parents.every(value => OID.test(value))) throw new Error('malformed Git commit graph')
  const violations: string[] = []
  const options = ['--no-commit-id', '--name-status', '--no-ext-diff', '--no-textconv', '--find-renames', '-r', '-z']
  for (const parent of parents.length === 1 ? [null] : parents.slice(1)) {
    violations.push(...contentScopeViolations(parseNameStatusZ(await git(root,
      parent === null ? ['diff-tree', '--root', ...options, head] : ['diff-tree', ...options, parent, head],
    ))))
  }
  return [...new Set(violations)]
}

/** Config that can publish additional refs or use a different push endpoint is unsupported. */
async function pushConfigurationViolations(root: string, git: GitRunner): Promise<string[]> {
  const config = await git(root, ['config', '--null', '--list'])
  for (const item of config.split('\0').filter(Boolean)) {
    const boundary = item.indexOf('\n')
    const key = (boundary < 0 ? item : item.slice(0, boundary)).toLowerCase()
    const value = boundary < 0 ? '' : item.slice(boundary + 1)
    if (key === 'remote.origin.mirror' || key === 'push.followtags') {
      if (!['false', 'no', 'off', '0'].includes(value.toLowerCase())) return [`unsafe publication config: ${key}`]
    }
    if (key === 'remote.origin.push' || key === 'remote.origin.receivepack') return [`unsupported publication config: ${key}`]
  }
  const fetchUrls = (await git(root, ['remote', 'get-url', '--all', 'origin'])).trim().split('\n')
  const pushUrls = (await git(root, ['remote', 'get-url', '--push', '--all', 'origin'])).trim().split('\n')
  if (fetchUrls.length !== 1 || pushUrls.length !== 1 || fetchUrls[0] === '' || fetchUrls[0] !== pushUrls[0]) {
    return ['origin must have one identical fetch and push destination']
  }
  return []
}

/** Check the exact branch source against live origin truth, never local tracking refs. */
export async function pushScopeViolations(root: string, branch: string, git: GitRunner = spawnGit): Promise<string[]> {
  const ref = `refs/heads/${branch}`
  await git(root, ['check-ref-format', ref])
  const configuration = await pushConfigurationViolations(root, git)
  if (configuration.length > 0) return configuration
  const after = await commitOid(root, ref, git)
  const remote = (await git(root, ['ls-remote', '--refs', 'origin', ref])).trim()
  let before: string | null = null
  if (remote !== '') {
    const rows = remote.split('\n')
    const [oid, remoteRef, extra] = rows[0]!.split('\t')
    if (rows.length !== 1 || oid === undefined || !OID.test(oid) || remoteRef !== ref || extra !== undefined) {
      throw new Error('Git returned ambiguous remote branch truth')
    }
    // Unknown remote objects fail closed; approval never relies on a guessed range.
    before = await commitOid(root, oid, git)
  }
  return commitRangeScopeViolations(root, before, after, git)
}

/** Command-aware scope verification shared by ordinary and escalation paths. */
export async function checkGrantContentScope(
  grant: Pick<TaskGrant, 'root' | 'branch' | 'contentScope'>,
  command: string,
  git: GitRunner = spawnGit,
): Promise<string[]> {
  if (grant.contentScope !== 'tracked-md-only') return []
  const shape = scopedCommandShapeViolations(command, grant.branch)
  if (shape.length > 0) return shape
  if (isCommitCommand(command)) return commitScopeViolations(grant.root, git)
  if (isPushCommand(command)) {
    if (grant.branch === null) return ['push under a grant with no branch']
    return pushScopeViolations(grant.root, grant.branch, git)
  }
  return []
}

/** Whether ANY segment is a Git subcommand, using the shared literal argv parser. */
function anyGitSubcommand(command: string, subcommand: string): boolean {
  const split = splitShellCommand(command)
  if (split.kind !== 'segments') return true
  return split.segments.some(segment => {
    const invocation = parseTaskGrantGitInvocation(segment)
    return invocation.kind === 'unsupported' || (invocation.kind === 'git' && invocation.subcommand === subcommand)
  })
}

/** Whether command text invokes Git commit (unknown Git syntax fails closed). */
export function isCommitCommand(command: string): boolean { return anyGitSubcommand(command, 'commit') }
/** Whether command text invokes Git push (unknown Git syntax fails closed). */
export function isPushCommand(command: string): boolean { return anyGitSubcommand(command, 'push') }
/** Compatibility detection; automatic scoped authorization rejects these forms. */
export function stagesAtCommit(command: string): boolean {
  const split = splitShellCommand(command)
  if (split.kind !== 'segments') return true
  return split.segments.some(segment => {
    const invocation = parseTaskGrantGitInvocation(segment)
    return invocation.kind === 'unsupported' || (invocation.kind === 'git' && invocation.subcommand === 'commit'
      && invocation.args.some(arg => arg === '--all' || (/^-[A-Za-z]+$/.test(arg) && arg.includes('a'))))
  })
}
