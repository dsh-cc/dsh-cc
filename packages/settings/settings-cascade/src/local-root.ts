/**
 * Local-settings directory resolution: Claude Code reads
 * `.claude/settings.local.json` from the git **main checkout root** when the
 * session starts inside a linked worktree, or from the git toplevel when it
 * starts in a subdirectory. This module computes that directory without
 * touching the session cwd or git working tree. Git probes and `stat` are read-only.
 *
 * The linked-worktree detector and canonicalisation mirror the TUI project
 * identity code in `packages/ui/tui/src/project.ts` (`isLinkedWorktree`,
 * `canonical`) — see the comment there pointing back here. Keep the two in
 * sync; they must not drift.
 *
 * Node builtins only: this file is imported through the
 * `@dsh-cc/settings-cascade/local-root` subpath by packages that must
 * not pull in cordis or the settings runtime.
 *
 * @module @dsh-cc/settings-cascade/local-root
 */

import { spawnSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

/** Git probe timeout, mirroring the TUI `gitExecSync` bound. */
const GIT_PROBE_TIMEOUT_MS = 2000

/** A successful synchronous git invocation. */
export interface LocalRootExecResult {
  stdout: string
}

/**
 * Run one git argv in `cwd`, synchronously. Returns undefined on spawn
 * failure, non-zero exit, or timeout. Injectable so tests script the git
 * conversation; the default spawns real `git`.
 */
export type LocalRootExec = (argv: readonly string[], cwd: string) => LocalRootExecResult | undefined

/** Injectable environment for {@link resolveLocalSettingsDir} (tests only). */
export interface LocalRootDeps {
  /** Git probe; defaults to a bounded `spawnSync('git', …)`. */
  exec?: LocalRootExec
  /** Home directory; defaults to `os.homedir()`. */
  homedir?: string
  /** Platform override; defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** Current uid; when undefined the uid comparison is skipped. */
  getuid?: () => number | undefined
  /** stat-like probe returning the owner uid; may throw (fail-closed). */
  stat?: (path: string) => { uid: number }
}

/** The default exec: real `git` via spawnSync with a bounded timeout. */
const defaultExec: LocalRootExec = (argv, cwd) => {
  const result = spawnSync('git', [...argv], { cwd, encoding: 'utf8', timeout: GIT_PROBE_TIMEOUT_MS })
  if (result.error !== undefined || result.status !== 0) return undefined
  return { stdout: result.stdout }
}

/** Canonicalise a path: resolve then dereference symlinks; resolve on failure. */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * True when `commonDir` marks a *linked* worktree whose main root is its
 * parent. Mirrors `isLinkedWorktree` in `packages/ui/tui/src/project.ts` —
 * keep the two in sync (see the module doc comment there).
 */
function isLinkedWorktree(commonDir: string, top: string): boolean {
  if (!commonDir.endsWith(`${sep}.git`)) return false
  return resolve(commonDir) !== resolve(join(top, '.git'))
}

/** Best-effort owner uid; undefined when stat fails (absent or unreadable). */
function ownerUid(path: string, deps: LocalRootDeps): number | undefined {
  const stat = deps.stat ?? (path => statSync(path))
  try {
    return stat(path).uid
  } catch {
    return undefined
  }
}

/** Module-level memo keyed by `resolve(cwd)`, default-exec calls only. */
const cache = new Map<string, string>()

/** Test hook: drop the module-level memo. */
export function __clearLocalRootCache(): void {
  cache.clear()
}

/**
 * Resolve the directory that holds `.claude/settings.local.json` for a
 * launch directory. Hoists to the git main checkout root (linked worktree)
 * or the git toplevel (subdirectory start) unless a safety fallback applies:
 * not a git repo, Windows, repo root equals `$HOME`, a bare-main hoist
 * target without `.git`, or ownership of the repo root / `.git` / `.claude`
 * cannot be confirmed as the current user (fail-closed). Paths *inside* the
 * file still resolve against the launch directory.
 *
 * Results are memoised per resolved `cwd` for the default exec only;
 * injected execs bypass the cache entirely (see `__clearLocalRootCache`).
 */
export function resolveLocalSettingsDir(cwd: string, deps: LocalRootDeps = {}): string {
  const key = resolve(cwd)
  if (deps.exec === undefined) {
    const memoised = cache.get(key)
    if (memoised !== undefined) return memoised
  }
  const result = resolveUncached(cwd, deps)
  if (deps.exec === undefined) cache.set(key, result)
  return result
}

function resolveUncached(cwd: string, deps: LocalRootDeps): string {
  // Windows paths/permissions differ; Claude Code keeps the local file local.
  if ((deps.platform ?? process.platform) === 'win32') return resolve(cwd)

  const exec = deps.exec ?? defaultExec
  const topRaw = exec(['rev-parse', '--show-toplevel'], cwd)?.stdout.trim()
  if (topRaw === undefined || topRaw.length === 0) return resolve(cwd)
  const commonRaw = exec(['rev-parse', '--git-common-dir'], cwd)?.stdout.trim()
  if (commonRaw === undefined || commonRaw.length === 0) return resolve(cwd)

  const topAbs = canonical(topRaw)
  const commonDir = canonical(resolve(cwd, commonRaw))
  const hoist = isLinkedWorktree(commonDir, topAbs)
  const mainRoot = hoist ? dirname(commonDir) : topAbs

  // Bare-main guard: a hoisted common dir like `/x/repo.git` would resolve
  // the "main root" to `/x`, which is not a checkout. A missing or
  // unstatable `<mainRoot>/.git` refuses the hoist (the required-`.git`
  // check below also fails closed on it).
  if (hoist && ownerUid(join(mainRoot, '.git'), deps) === undefined) return resolve(cwd)

  // Never let the local file live directly in $HOME.
  if (canonical(deps.homedir ?? osHomedir()) === mainRoot) return resolve(cwd)

  // Tests inject `getuid`; production uses `process.getuid` (absent on
  // win32, which already returned above). An explicit `getuid: () => undefined`
  // skips the uid comparison while still fail-closing on a throwing stat.
  const uid = (deps.getuid ?? (() => process.getuid?.()))()
  // Fail-closed: mainRoot and <mainRoot>/.git must stat AND (when the uid is
  // observable) be owned by the current user. <mainRoot>/.claude is optional
  // — ENOENT is fine, the file may be created later — but an EACCES on a
  // 0700 `.git` must not escape the guard.
  const checks: ReadonlyArray<readonly [string, boolean]> = [
    [mainRoot, true],
    [join(mainRoot, '.git'), true],
    [join(mainRoot, '.claude'), false],
  ]
  for (const [path, required] of checks) {
    const owner = ownerUid(path, deps)
    if (owner === undefined) {
      if (required) return resolve(cwd)
      continue
    }
    if (uid !== undefined && owner !== uid) return resolve(cwd)
  }
  return mainRoot
}
