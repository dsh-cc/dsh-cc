/**
 * Memdir root resolution: the default harness-home memory directory plus an
 * optional per-project `.claude/memory` overlay. All reads go through the
 * optional `ctx.fs` seam so remote backends work unchanged.
 * @module @dsh-cc/memory/paths
 */

import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { defaultDshHome } from '@deepseek-ai/dsh-home-paths'

/** Directory label for the project-scoped memory overlay. */
export const PROJECT_MEMORY_DIR = '.claude/memory'

/** Directory label grouping the per-workspace memory directories. */
export const PROJECTS_DIR = 'projects'

/**
 * Git probe timeout for {@link canonicalMemoryRoot}. Bounded so a hung git
 * (network FS, broken env) cannot stall the synchronous system-prompt
 * `text` callback past the section's first-assembly budget.
 */
export const GIT_PROBE_TIMEOUT_MS = 500

/** A successful synchronous git invocation. */
export interface MemoryGitExecResult {
  stdout: string
}

/**
 * Run one git argv in `cwd`, synchronously. Returns undefined on spawn
 * failure, non-zero exit, or timeout — the caller treats that as "not a git
 * repository". Injectable so tests script the git conversation.
 */
export type MemoryGitExec = (argv: readonly string[], cwd: string) => MemoryGitExecResult | undefined

/** The default exec: real `git` via spawnSync with a bounded timeout. */
export function gitExecSync(argv: readonly string[], cwd: string): MemoryGitExecResult | undefined {
  const result = spawnSync('git', [...argv], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_PROBE_TIMEOUT_MS,
  })
  if (result.error !== undefined || result.status !== 0) return undefined
  return { stdout: result.stdout }
}

/**
 * Resolve the default (harness-home) memory root. A configured root wins;
 * otherwise the shared harness home.
 * @param configured - an explicit root, or `undefined` for the default.
 * @returns the resolved harness-home memory directory.
 */
export function resolveMemoryHome(configured?: string): string {
  return configured !== undefined && configured.length > 0
    ? configured
    : join(defaultDshHome(), 'memory')
}

/**
 * Encode a workspace path as a single filesystem-safe directory name. Ported
 * from upstream `projectKey` (`session-persistence-jsonl/src/format.ts`),
 * minus the `--` wrapper: separators and drive colons collapse to `-`, unsafe
 * code units escape as `~XXXX`, leading dashes strip, and the result
 * truncates to 251 chars (fallback `root`). The input is the canonical git
 * root from {@link canonicalMemoryRoot}, so worktrees of one repo share a
 * slug even though session transcripts still group by raw cwd.
 * @param cwd - the workspace path to encode.
 * @returns the workspace slug.
 */
export function projectSlug(cwd: string): string {
  if (cwd.length === 0) return 'root'
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return slug.slice(0, 251)
}

/**
 * True when `commonDir` marks a *linked* worktree whose project root is its
 * directory's parent. The common dir of a standard layout is `<root>/.git`;
 * a linked worktree reports its main checkout's `/.git`, which differs from
 * its own `top/.git`. Anything else (main checkout, a submodule's
 * `<super>/.git/modules/<name>`, bare, exotic GIT_DIR) is not a linked
 * worktree and keeps `resolve(top)` as its project root — so submodules do
 * not collapse onto their superproject.
 */
function isLinkedWorktree(commonDir: string, top: string): boolean {
  if (!commonDir.endsWith(`${sep}.git`)) return false
  return resolve(commonDir) !== resolve(join(top, '.git'))
}

/**
 * Canonicalise a path: `resolve()` then dereference symlinks via realpath so
 * a repo reached through a symlinked ancestor (e.g. macOS `/var` →
 * `/private/var`) yields the SAME string whether it came from `resolve(cwd)`,
 * git's toplevel, or git's common-dir — git may mix realpath'd and non-
 * realpath'd output for the same directory, which would otherwise split one
 * memory bucket into two. Falls back to `resolve()` if realpath fails (e.g.
 * the path no longer exists).
 */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Module-level memo keyed by `resolve(cwd)` (see {@link canonicalMemoryRoot}). */
const memoryRootCache = new Map<string, string>()

/** Test hook: drop the module-level memo (also safe as a no-op cleanup). */
export function __clearMemoryRootCache(): void {
  memoryRootCache.clear()
}

/**
 * The canonical git-repo root a cwd's workspace memories belong to.
 *
 * Matches Claude Code auto-memory identity: derived from the git repository
 * so worktrees and subdirectories share one store. A linked worktree
 * collapses onto the main checkout (`dirname(git-common-dir)`); a submodule
 * keeps its own toplevel. Non-git / git failure / timeout degrades to
 * `resolve(cwd)` — today's pre-collapse behavior.
 *
 * Results are memoised per resolved `cwd` so the synchronous system-prompt
 * section probes git at most once per working directory. Only default-exec
 * calls participate: an injected `exec` bypasses the cache entirely.
 * @param cwd - the session working directory.
 * @param exec - git probe; defaults to {@link gitExecSync}.
 * @returns the absolute canonical root to slug.
 */
export function canonicalMemoryRoot(cwd: string, exec: MemoryGitExec = gitExecSync): string {
  const key = resolve(cwd)
  if (exec === gitExecSync) {
    const cached = memoryRootCache.get(key)
    if (cached !== undefined) return cached
  }
  const root = probeMemoryRoot(cwd, exec)
  if (exec === gitExecSync) memoryRootCache.set(key, root)
  return root
}

/**
 * One spawn: `git rev-parse --show-toplevel --git-common-dir` prints the
 * toplevel then the common dir, one per line. A relative common-dir is
 * resolved against the probe cwd.
 */
function probeMemoryRoot(cwd: string, exec: MemoryGitExec): string {
  const parsed = exec(['rev-parse', '--show-toplevel', '--git-common-dir'], cwd)?.stdout
  if (parsed === undefined) return resolve(cwd)
  const lines = parsed.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  const top = lines[0]
  const commonRaw = lines[1]
  if (top === undefined || top.length === 0 || commonRaw === undefined || commonRaw.length === 0) {
    return resolve(cwd)
  }
  const topAbs = canonical(top)
  const commonDir = canonical(resolve(cwd, commonRaw))
  return isLinkedWorktree(commonDir, topAbs) ? dirname(commonDir) : topAbs
}

/**
 * Resolve the per-workspace private memory directory under a memory home:
 * `<home>/projects/<slug>` where the slug encodes the canonical git root
 * of `cwd` (worktrees and subdirectories of one repo share a directory).
 * @param home - the resolved memory home (the global layer's directory).
 * @param cwd - the session working directory; collapsed via {@link canonicalMemoryRoot}.
 * @param exec - optional git probe (tests); omitted uses the default exec.
 * @returns the workspace memory directory.
 */
export function resolveWorkspaceMemoryDir(home: string, cwd: string, exec?: MemoryGitExec): string {
  const root = exec === undefined ? canonicalMemoryRoot(cwd) : canonicalMemoryRoot(cwd, exec)
  return join(home, PROJECTS_DIR, projectSlug(root))
}

/**
 * The workspace path an agent's memories belong to: the session's bound cwd,
 * falling back to the process cwd when the header carries none.
 *
 * This is the *live working copy*, not the memory-bucket identity. Task uses
 * it to find `.claude/agents` inside a worktree; {@link resolveWorkspaceMemoryDir}
 * collapses it onto the git root before slugging.
 * @param agent - the agent whose workspace is needed.
 * @returns the workspace cwd.
 */
export function cwdOf(agent: Agent): string {
  return agent.session.header.cwd ?? process.cwd()
}

/**
 * Disco the project-scoped memory root for a cwd, or `undefined` when the
 * filesystem service is absent or no project root is reachable.
 * @param ctx - the host context carrying the optional `fs` service.
 * @param cwd - the descendant path whose project root bounds the overlay.
 * @returns the project memory directory, or `undefined` when not discoverable.
 */
export async function resolveProjectMemoryRoot(
  ctx: Context,
  cwd: string,
): Promise<string | undefined> {
  const fileSystem = ctx.get('fs')
  if (fileSystem === undefined) return undefined
  const cwdResolved = await readResolve(fileSystem, cwd, ctx)
  const root = await findProjectRoot(cwdResolved, fileSystem)
  if (root === undefined) return undefined
  return join(root, PROJECT_MEMORY_DIR)
}

async function readResolve(fs: FileSystem, path: string, ctx: Context): Promise<string> {
  try {
    return (await fs.resolve(path)).displayPath
  } catch (error) {
    ctx.logger.warn(`memory: failed to resolve cwd ${path}: ${String(error)}`)
    return path
  }
}

async function findProjectRoot(cwd: string, fs: FileSystem): Promise<string | undefined> {
  let current = cwd
  while (true) {
    if (await pathExists(fs, join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

async function pathExists(fs: FileSystem, path: string): Promise<boolean> {
  try {
    const target = await fs.resolve(path)
    return await fs.stat(target) !== undefined
  } catch {
    // A backend may refuse or hide the candidate; keep walking upward.
    return false
  }
}
