/**
 * Project (working-directory identity) resolution for session management.
 *
 * A "project" is the namespace sessions, resume markers, and input history
 * share. For a cwd inside a git repository the project is pinned to the
 * *main repo root*, so an isolation worktree (`--worktree`,
 * `.claude/worktrees/<slug>`) keeps the same project as its main checkout;
 * for a cwd outside git the project is the directory itself. Every member
 * path is `resolve()`d to a canonical absolute form and keyed by a short
 * sha256 of the project root (deliberately not a lossy string encoding like
 * Claude Code's `-` separator scheme — see design).
 *
 * All git probing runs through an injectable synchronous exec so tests never
 * spawn git; any failure or timeout degrades to the directory identity.
 *
 * @module @dsh-cc/tui/project
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

/**
 * Git invocation timeout. A hung git (network FS, broken env) must not block
 * session boot; expiry degrades to the directory identity. Generous for
 * slow repos while still bounding the worst case.
 */
export const GIT_PROBE_TIMEOUT_MS = 2000

/** A successful synchronous git invocation. */
export interface ProjectExecResult {
  stdout: string
}

/**
 * Run one git argv in `cwd`, synchronously. Returns undefined on spawn
 * failure, non-zero exit, or timeout — the caller treats that as "not a git
 * repository". Injectable so tests script the git conversation.
 */
export type ProjectExec = (argv: readonly string[], cwd: string) => ProjectExecResult | undefined

/** The default exec: real `git` via spawnSync with a bounded timeout. */
export const gitExecSync: ProjectExec = (argv, cwd) => {
  const result = spawnSync('git', [...argv], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_PROBE_TIMEOUT_MS,
  })
  if (result.error !== undefined || result.status !== 0) return undefined
  return { stdout: result.stdout }
}

/** Resolved project identity for a cwd. */
export interface ProjectInfo {
  /**
   * Canonical project root: the main git repo root for a cwd inside a git
   * repository (link worktrees collapse onto their main checkout), else
   * `resolve(cwd)`.
   */
  readonly projectRoot: string
  /** `sha256(projectRoot)` first 16 hex chars — the per-project bucket key. */
  readonly projectKey: string
  /**
   * Every linked worktree of the project's repository, `resolve()`d to an
   * absolute path. `[]` when the repo cannot be enumerated (or is not git).
   */
  readonly worktrees: string[]
}

/**
 * True when `commonDir` marks a *linked* worktree whose project root is its
 * directory's parent. The common dir of a standard layout is `<root>/.git`;
 * a linked worktree reports its main checkout's `/.git`, which differs from
 * its own `top/.git`. Anything else (main checkout, a submodule's
 * `<super>/.git/modules/<name>`, bare, exotic GIT_DIR) is not a linked
 * worktree and keeps `resolve(top)` as its project root — so submodules do
 * not collapse onto their superproject.
 *
 * Keep in sync with `isLinkedWorktree` in
 * `packages/settings/settings-cascade/src/local-root.ts`, which replicates
 * this detector for local-settings hoisting (see its module doc).
 */
function isLinkedWorktree(commonDir: string, top: string): boolean {
  if (!commonDir.endsWith(`${sep}.git`)) return false
  return resolve(commonDir) !== resolve(join(top, '.git'))
}

/** Resolve one `worktree <path>` porcelain line, handling git's C-style quoting. */
function unquoteWorktreePath(line: string): string {
  if (line.length === 0 || line[0] !== '"') return line
  // strip surrounding quotes and decode git's C-style escapes (`\n` `\t`
  // `\"` `\\`); unknown escapes keep the backslash verbatim.
  const inner = line.slice(1, -1)
  let out = ''
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (ch === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1]
      if (next === 'n') { out += '\n'; i += 1; continue }
      if (next === 't') { out += '\t'; i += 1; continue }
      if (next === '\\' || next === '"') { out += next; i += 1; continue }
    }
    out += ch
  }
  return out
}

/**
 * Resolve the project identity for `cwd`. Git is probed via the injectable
 * exec (defaults to real `git`); any failure or timeout degrades to a
 * directory identity (`projectRoot = resolve(cwd)`, no worktrees).
 *
 * Results are memoised per resolved `cwd` so every process probes git at
 * most once per working directory (driver clients call this in hot spots —
 * boot, picker open, history rebind — and reuse the same identity). Only
 * default-exec calls participate: an injected `exec` bypasses the cache
 * entirely, so scripted-exec tests and external probing stay deterministic.
 * {@link __clearProjectCache} resets the memo (used by tests).
 */
export function resolveProject(cwd: string, exec: ProjectExec = gitExecSync): ProjectInfo {
  const key = resolve(cwd)
  const memoised = exec === gitExecSync ? projectCache.get(key) : undefined
  if (memoised !== undefined) return memoised

  const info = probeProject(cwd, exec)

  if (exec === gitExecSync) projectCache.set(key, info)
  return info
}

/** Module-level memo keyed by `resolve(cwd)` (see {@link resolveProject}). */
const projectCache = new Map<string, ProjectInfo>()

/** Test hook: drop the module-level memo (also safe as a no-op cleanup). */
export function __clearProjectCache(): void {
  projectCache.clear()
}

/**
 * Canonicalise a path: `resolve()` then dereference symlinks via realpath so
 * a repo reached through a symlinked ancestor (e.g. macOS `/var` →
 * `/private/var`) yields the SAME string whether it came from `resolve(cwd)`,
 * git's toplevel, or git's common-dir — git may mix realpath'd and non-
 * realpath'd output for the same directory, which would otherwise split one
 * project into two keys. Falls back to `resolve()` if realpath fails (e.g.
 * the path no longer exists).
 */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** The uncached git probe (shared by {@link resolveProject} and tests). */
function probeProject(cwd: string, exec: ProjectExec): ProjectInfo {
  const top = exec(['rev-parse', '--show-toplevel'], cwd)?.stdout.trim()
  if (top === undefined || top.length === 0) return fallbackProject(cwd)
  const commonRaw = exec(['rev-parse', '--git-common-dir'], cwd)?.stdout.trim()
  if (commonRaw === undefined || commonRaw.length === 0) return fallbackProject(cwd)

  const topAbs = canonical(top)
  const commonDir = canonical(resolve(cwd, commonRaw))
  const projectRoot = isLinkedWorktree(commonDir, topAbs) ? dirname(commonDir) : topAbs

  // Best-effort worktree enumeration; a failure just yields an empty set —
  // the caller's prefix heuristic still covers the main checkout.
  let worktrees: string[] = []
  const porcelain = exec(['worktree', 'list', '--porcelain'], cwd)
  if (porcelain !== undefined) {
    for (const line of porcelain.stdout.split('\n')) {
      if (!line.startsWith('worktree ')) continue
      const path = unquoteWorktreePath(line.slice('worktree '.length).trim())
      if (path.length > 0) worktrees.push(canonical(path))
    }
  }

  return { projectRoot, projectKey: projectKeyFor(projectRoot), worktrees }
}

/** Degraded identity for a non-git (or un-probeable) cwd. */
function fallbackProject(cwd: string): ProjectInfo {
  const projectRoot = resolve(cwd)
  return { projectRoot, projectKey: projectKeyFor(projectRoot), worktrees: [] }
}

/** `sha256(root)` first 16 hex chars — the per-project bucket key. */
function projectKeyFor(projectRoot: string): string {
  return createHash('sha256').update(projectRoot).digest('hex').slice(0, 16)
}

/**
 * Whether `entryCwd` belongs to the project: it equals the project root or
 * any worktree path, or sits beneath one at a path-separator boundary
 * (`/repo` matches `/repo` and `/repo/x`, never `/repo2`). Both `/` and `\`
 * count as boundary separators so Windows-style recorded cwds are handled
 * regardless of the host separator.
 */
export function isProjectMember(
  entryCwd: string,
  project: Pick<ProjectInfo, 'projectRoot' | 'worktrees'>,
): boolean {
  const entry = resolve(entryCwd)
  const candidates = [project.projectRoot, ...project.worktrees]
  for (const candidate of candidates) {
    if (isWithin(candidate, entry)) return true
  }
  return false
}

/** True when `child` equals `parent` or sits beneath it at a separator boundary. */
function isWithin(parent: string, child: string): boolean {
  const p = resolve(parent)
  const c = resolve(child)
  if (c === p) return true
  if (!c.startsWith(p)) return false
  const rest = c.slice(p.length)
  return rest.startsWith('/') || rest.startsWith('\\')
}
