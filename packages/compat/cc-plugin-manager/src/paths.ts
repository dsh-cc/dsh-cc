/**
 * Path resolution for Claude Code plugin state: the `<claudeHome>/plugins/`
 * state layout and the per-scope settings file (C1/D2 ground truth). The
 * local scope resolves against the git MAIN checkout's
 * `.claude/settings.local.json` — from a linked worktree that means walking
 * the `gitdir:` pointer in `<worktree>/.git` back to the main checkout.
 *
 * All cwd-derived paths are canonicalized with `fs.realpathSync.native`
 * (macOS `/tmp` → `/private/tmp` semantics), gracefully falling back to
 * canonicalizing the deepest existing ancestor for not-yet-existing paths.
 *
 * @module @dsh-cc/plugin-manager/paths
 */

import { existsSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

export interface PathInputs {
  claudeHome: string
  /**
   * dsh write home. Defaults to `claudeHome` (legacy single-root semantics,
   * plan §3.1): an explicit `claudeHome` alone always means single-root.
   */
  dshHome?: string
  cwd: string
}

export interface PluginsStatePaths {
  stateDir: string
  knownMarketplacesFile: string
  installedPluginsFile: string
  marketplacesDir: string
  cacheDir: string
  dataDir: string
}

/**
 * Canonicalize a path even when it (or its parents) do not exist yet:
 * realpath the deepest existing ancestor and append the remaining segments.
 */
export function canonicalizeExistingPath(path: string): string {
  const absolute = resolve(path)
  if (existsSync(absolute)) {
    return realpathSync.native(absolute)
  }
  const parent = dirname(absolute)
  if (parent === absolute) {
    return absolute
  }
  const canonicalParent = canonicalizeExistingPath(parent)
  return join(canonicalParent, absolute.slice(parent.length + 1))
}

/** Resolve both homes: the dsh home (write root) defaults to `claudeHome` (§3.1). */
function resolveHomes({ claudeHome, dshHome }: PathInputs): { dshHome: string; claudeHome: string } {
  return { claudeHome, dshHome: dshHome ?? claudeHome }
}

/** State layout under one home root (§2.2). */
function statePathsIn(home: string): PluginsStatePaths {
  const stateDir = join(home, 'plugins')
  return {
    stateDir,
    knownMarketplacesFile: join(stateDir, 'known_marketplaces.json'),
    installedPluginsFile: join(stateDir, 'installed_plugins.json'),
    marketplacesDir: join(stateDir, 'marketplaces'),
    cacheDir: join(stateDir, 'cache'),
    dataDir: join(stateDir, 'data'),
  }
}

/**
 * Layout of the plugin state root `<dshHome>/plugins/` — the WRITE root
 * (plan §1 R2). In single-root mode `dshHome` falls back to `claudeHome`.
 */
export function pluginsStatePaths(deps: PathInputs): PluginsStatePaths {
  return statePathsIn(resolveHomes(deps).dshHome)
}

/**
 * Claude-side state layout (compat READ root, plan §1 R1), or `null` when
 * both homes canonicalize to the same directory (symlinked homes collapse;
 * single-root merge is a no-op).
 */
export function claudePluginsStatePaths(deps: PathInputs): PluginsStatePaths | null {
  const { claudeHome, dshHome } = resolveHomes(deps)
  if (canonicalizeExistingPath(claudeHome) === canonicalizeExistingPath(dshHome)) return null
  return statePathsIn(claudeHome)
}

/**
 * Walk up from `cwd` to the git main checkout root. Handles both a real
 * `.git` directory and a linked worktree where `.git` is a file containing
 * `gitdir: <main>/.git/worktrees/<name>` (or a symlink to it) — the main
 * checkout is the directory owning the `.git` pointed at.
 *
 * Returns null when no git tree is found.
 */
export function findGitMainRoot(cwd: string): string | null {
  let current = resolve(cwd)
  for (;;) {
    const git = join(current, '.git')
    if (existsSync(git)) {
      const resolved = resolveGitEntry(git)
      if (resolved !== null) return resolved
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * From a per-worktree gitdir `<main>/.git/worktrees/<name>` return
 * `<main>` (the directory containing `.git`); null when the shape differs.
 */
function mainRootFromGitdir(gitdir: string): string | null {
  const gitMarker = `${sep}.git${sep}`
  const idx = gitdir.lastIndexOf(gitMarker)
  if (idx > 0) return gitdir.slice(0, idx)
  return null
}

/**
 * Resolve a `.git` entry: a directory means `dir` is the checkout root; a
 * file (or symlink) means `gitdir: <path>` — the main checkout root is the
 * directory containing the `.git` the gitdir lives under.
 */
function resolveGitEntry(gitPath: string): string | null {
  let stat: Stats
  try {
    // statSync follows symlinks: a worktree .git may be a symlink to the gitdir
    stat = statSync(gitPath)
  } catch {
    return null
  }
  if (stat.isDirectory()) {
    const rp = realpathSync.native(gitPath)
    if (rp === gitPath) return dirname(rp)
    // symlink pointing at a per-worktree gitdir: <main>/.git/worktrees/<name>
    const mainRoot = mainRootFromGitdir(rp)
    return mainRoot ?? dirname(rp)
  }
  // .git is a file: parse `gitdir: <path>`
  let contents: string
  try {
    contents = readFileSync(gitPath, 'utf8').trim()
  } catch {
    return null
  }
  const match = /^gitdir:\s*(.+)$/.exec(contents)
  if (!match) return null
  let gitdir = match[1]!.trim()
  if (!isAbsolute(gitdir)) gitdir = resolve(dirname(gitPath), gitdir)
  gitdir = realpathSync.native(gitdir)
  // gitdir = <main>/.git/worktrees/<name>  →  main = <main>
  return mainRootFromGitdir(gitdir) ?? dirname(dirname(gitdir))
}

/**
 * Settings file per scope (C1/C3):
 * - user:    `<dshHome>/settings.json` — the WRITE target (plan §3.3; the
 *   dsh home defaults to `claudeHome`, so single-root keeps the claude path)
 * - project: `<cwd>/.claude/settings.json`
 * - local:   `<gitMainRoot>/.claude/settings.local.json` (gitMainRoot
 *   defaults to cwd when not inside a worktree)
 *
 * cwd-derived results are realpath-canonicalized.
 */
export function settingsFileForScope(
  scope: 'user' | 'project' | 'local',
  deps: PathInputs & { gitMainRoot?: string },
): string {
  if (scope === 'user') return join(resolveHomes(deps).dshHome, 'settings.json')
  const { cwd, gitMainRoot } = deps
  const canonicalCwd = canonicalizeExistingPath(cwd)
  if (scope === 'project') return join(canonicalCwd, '.claude', 'settings.json')
  const mainRoot = canonicalizeExistingPath(gitMainRoot ?? findGitMainRoot(canonicalCwd) ?? canonicalCwd)
  return join(mainRoot, '.claude', 'settings.local.json')
}

/**
 * User-scope settings read files in low → high precedence order (plan §3.3):
 * `[<claudeHome>/settings.json, <dshHome>/settings.json]`, deduped to a
 * single entry when the homes canonicalize equal (single-root).
 */
export function userSettingsReadFiles(deps: PathInputs): string[] {
  const { claudeHome, dshHome } = resolveHomes(deps)
  const claudeFile = join(claudeHome, 'settings.json')
  const dshFile = join(dshHome, 'settings.json')
  if (canonicalizeExistingPath(claudeFile) === canonicalizeExistingPath(dshFile)) return [dshFile]
  return [claudeFile, dshFile]
}
