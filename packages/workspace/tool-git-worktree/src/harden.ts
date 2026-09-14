/**
 * Creation-hardening helpers shared by the EnterWorktree path (WS-1 of
 * docs/plans/2026-09-14-cc-worktree-parity.md): common-dir root pinning,
 * repository-local filter-driver neutralization, and the git-identity check
 * for adopting an existing directory. Pure functions over plain input where
 * possible; the two fs-touching helpers use `node:fs` directly because they
 * must see symlinks (`ctx.fs.resolve` follows them by design).
 * @module @dsh-cc/tool-git-worktree/harden
 */

import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
/**
 * Pin the repository root to the git common dir: `git rev-parse
 * --git-common-dir` run at the probe cwd, relative answers resolved against
 * that cwd, root = parent of `<mainRoot>/.git`. Inside a linked worktree the
 * common dir already points at the main checkout's `.git`, so worktrees are
 * always created as siblings under the main root's `.claude/worktrees/` —
 * never nested inside the running worktree.
 * @param cwd - The working directory the git probe ran in.
 * @param output - Raw stdout of the `--git-common-dir` probe.
 * @returns the main repository root, or `undefined` when the answer is empty.
 */
export function repoRootFromCommonDir(cwd: string, output: string): string | undefined {
  const raw = output.trim()
  if (raw.length === 0) return undefined
  const commonDir = isAbsolute(raw) ? raw : resolve(cwd, raw)
  return dirname(commonDir)
}

/** Result of scanning `git config --local --list` output. */
export interface LocalConfigScan {
  /** Every `filter.<name>.*` filter name found in the local config. */
  filters: string[]
  /** Named refusal reasons (CC parity: includeIf, ambiguous/unparsable keys). */
  refusals: string[]
}

/**
 * Parse `git config --local --list -z` output: entries are NUL-separated and
 * each is `key\nvalue`. The NUL form is what makes CC's filter-name refusals
 * decidable: a filter name containing `=` survives inside the key (plain
 * `--list` would hide it as a fake key/value split), and a hand-edited
 * config whose key contains a newline makes `git config` itself fail → the
 * unreadable-config refusal.
 * @param text - Raw stdout of the config list command.
 * @returns the scan result.
 */
export function scanLocalConfig(text: string): LocalConfigScan {
  const filters = new Set<string>()
  const refusals: string[] = []
  for (const entry of text.split('\0')) {
    if (entry.length === 0) continue
    const nl = entry.indexOf('\n')
    const rawKey = nl < 0 ? entry : entry.slice(0, nl)
    const key = rawKey.toLowerCase()
    if (key.startsWith('includeif.')) {
      refusals.push(`refusing local config with includeIf: ${rawKey}`)
      continue
    }
    if (!key.startsWith('filter.')) continue
    const name = key.slice('filter.'.length, key.lastIndexOf('.'))
    if (name.length === 0) continue
    if (name.includes('=') || name.includes('\n')) {
      refusals.push(`refusing filter driver with ambiguous name: filter.${name}.*`)
      continue
    }
    filters.add(name)
  }
  return { filters: [...filters], refusals }
}

/**
 * `git -c` argument pairs that neutralize every repository-local filter
 * driver before `git worktree add`. Mechanism chosen empirically (git 2.54
 * content-marker experiment, 2026-09): overriding every `filter.<name>.*` key
 * seen in the local config with an empty value plus `required=false`
 * provably suppresses filter execution during `git worktree add` (baseline
 * checkout ran the smudge filter and rewrote content; the overridden run
 * left blob content untouched). `required=false` alone does NOT suppress —
 * the filter still executes and only tolerates failure; empty-string `-c`
 * overrides and env injection both suppress, `-c` is simpler. Emptied keys
 * that were never set are harmless no-ops.
 *
 * CC-parity consequence: LFS-tracked content arrives as pointer files;
 * `git lfs pull` inside the worktree restores it.
 * @param filters - Filter names collected by {@link scanLocalConfig}.
 * @returns raw `-c <key>=<value>` argv (execFile form; quote for shell use).
 */
export function neutralizationArgv(filters: readonly string[]): string[] {
  const argv: string[] = []
  for (const filter of filters) {
    for (const key of ['command', 'smudge', 'clean', 'process', 'required']) {
      const value = key === 'required' ? 'false' : ''
      argv.push('-c', `filter.${filter}.${key}=${value}`)
    }
  }
  return argv
}

/**
 * Git-identity check for adopting an existing directory as a worktree (WS-1
 * item 4). A target is adoptable only when its `.git` entry is a gitdir
 * pointer file resolving into the main checkout's `.git/worktrees/`
 * registration — a plain clone, a `core.worktree` redirect, or a directory
 * `.git` would make a later `git reset --hard` hit the main checkout.
 * Refusals leave the directory in place and name the recovery.
 * @param target - Absolute path of the existing directory.
 * @param mainRoot - The main checkout's repository root.
 * @returns the refusal reason, or `null` when the directory is adoptable.
 */
export function adoptionRefusal(target: string, mainRoot: string): string | null {
  if (relative(target, mainRoot) === '' || !relative(target, mainRoot).startsWith(`..${sep}`)) {
    return (
      `refusing to adopt ${target}: it contains the main checkout at ${mainRoot}. `
      + 'Remove or rename the directory (or pick another name) and retry.'
    )
  }
  const gitEntry = join(target, '.git')
  let kind: 'missing' | 'file' | 'directory' | 'other'
  try {
    kind = mapKind(lstatSync(gitEntry))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return (
        `refusing to adopt ${target}: it holds no git worktree (no .git entry) and may contain user work. `
        + 'Remove or rename the directory (or pick another name) and retry.'
      )
    }
    return (
      `refusing to adopt ${target}: its .git entry is unreadable. `
      + 'Inspect the directory manually; remove or rename it (or pick another name) and retry.'
    )
  }
  if (kind === 'missing') {
    return (
      `refusing to adopt ${target}: it holds no git worktree (no .git entry) and may contain user work. `
      + 'Remove or rename the directory (or pick another name) and retry.'
    )
  }
  if (kind !== 'file') {
    // Directory `.git`: a separate checkout/clone or a core.worktree redirect
    // — its commondir resolving into the main `.git` root would redirect
    // reset --hard at the main checkout. Refuse outright (CC parity).
    let detail = 'it is a separate checkout (directory .git), not a linked worktree'
    try {
      const common = readFileSync(join(gitEntry, 'commondir'), 'utf8').trim()
      if (isInside(join(mainRoot, '.git'), resolve(gitEntry, common))) {
        detail = 'its .git commondir resolves into the main checkout\'s own .git (plain-clone/core.worktree redirect shape)'
      }
    } catch {
      // no commondir file — the separate-checkout message stands.
    }
    return (
      `refusing to adopt ${target}: ${detail}. `
      + 'Remove or rename the directory (or pick another name) and retry.'
    )
  }
  let gitdir: string
  try {
    gitdir = readFileSync(gitEntry, 'utf8').trim()
  } catch {
    return (
      `refusing to adopt ${target}: its .git pointer file is unreadable. `
      + 'Inspect the directory manually; remove or rename it (or pick another name) and retry.'
    )
  }
  if (!gitdir.startsWith('gitdir:')) {
    return (
      `refusing to adopt ${target}: its .git entry is a file but not a gitdir pointer. `
      + 'Remove or rename the directory (or pick another name) and retry.'
    )
  }
  const registered = norm(resolve(target, gitdir.slice('gitdir:'.length).trim()))
  if (!isInside(norm(join(mainRoot, '.git', 'worktrees')), registered)) {
    return (
      `refusing to adopt ${target}: its .git pointer resolves to ${registered}, which is not this `
      + 'repository\'s worktree registration (.git/worktrees/). It may be a clone, redirect, or foreign worktree. '
      + 'Remove or rename the directory (or pick another name) and retry.'
    )
  }
  return null
}

/**
 * Canonicalize through macOS-style `/var` → `/private/var` symlinks so git's
 * realpath'd answers compare equal to mkdtemp-style inputs. Falls back to
 * the input when the path does not exist (unregistered trees).
 */
function norm(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function mapKind(info: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): 'missing' | 'file' | 'directory' | 'other' {
  if (info.isDirectory()) return 'directory'
  if (info.isFile()) return 'file'
  return 'other'
}

function isInside(parent: string, child: string): boolean {
  return child.startsWith(parent + sep) || child === parent
}
