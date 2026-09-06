/**
 * Centralized git-worktree command construction and active-session state for
 * `@dsh-cc/tool-git-worktree`. Keeping every git command in one module
 * is the seam a future pure-JS git implementation would replace; callers never
 * construct `git ...` argument lists themselves.
 * @module @dsh-cc/tool-git-worktree/worktree
 */

import { basename, join } from 'node:path'

/**
 * Maximum length of a worktree slug. Mirrors the claude-code reference constraint.
 */
export const MAX_SLUG_LENGTH = 64

/** Allowlist for one `/`-separated slug segment (letters, digits, `.`, `_`, `-`). */
const SEGMENT = /^[a-zA-Z0-9._-]+$/

/**
 * Validate a worktree slug to keep it inside `.claude/worktrees/` and safe as a
 * git branch suffix. Rejects empty segments, `.`/`..`, drive characters, and
 * leading/trailing slashes; allows `user/feature` nesting.
 * @param slug - The requested worktree name.
 * @returns nothing on success; throws on an invalid slug.
 */
export function validateSlug(slug: string): void {
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new Error(
      `invalid worktree name: must be ${MAX_SLUG_LENGTH} characters or fewer (got ${slug.length})`,
    )
  }
  for (const segment of slug.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new Error(
        `invalid worktree name "${slug}": must not contain "." or ".." path segments`,
      )
    }
    if (!SEGMENT.test(segment)) {
      throw new Error(
        `invalid worktree name "${slug}": each "/"-separated segment must be non-empty and contain only letters, digits, dots, underscores, and dashes`,
      )
    }
  }
}

/**
 * Flatten a possibly nested slug (`user/feature` → `user+feature`) into a value
 * safe as a single directory name and a single git ref. `+` is valid in branch
 * names and paths but absent from the slug allowlist, so the map is injective.
 * @param slug - A validated worktree slug.
 * @returns the flattened name under `.claude/worktrees/`.
 */
export function flattenSlug(slug: string): string {
  return slug.replaceAll('/', '+')
}

/**
 * The git branch backing a worktree. Prefixes `worktree-` so it never collides
 * with a user branch.
 * @param slug - A validated worktree slug.
 * @returns the branch name.
 */
export function worktreeBranch(slug: string): string {
  return `worktree-${flattenSlug(slug)}`
}

/**
 * The on-disk worktree path for a repo root and slug.
 * @param repoRoot - The canonical repository root.
 * @param slug - A validated worktree slug.
 * @returns the absolute worktree path.
 */
export function worktreePathFor(repoRoot: string, slug: string): string {
  return join(repoRoot, '.claude', 'worktrees', flattenSlug(slug))
}

/** The directory holding all worktrees for a repo root. */
export function worktreesDir(repoRoot: string): string {
  return join(repoRoot, '.claude', 'worktrees')
}

export interface GitCmd {
  /** The full command string to run in the shell. */
  readonly command: string
  /** The directory git runs in (the repo root, never the worktree being removed). */
  readonly workdir: string
  /** Short human label for logs and errors. */
  readonly label: string
}

/**
 * `git worktree add` on a fresh branch based on the current HEAD. Uses `-B`
 * (not `-b`) so a stale orphan branch left by a removed worktree is reset
 * rather than failing.
 * @param repoRoot - The canonical repository root.
 * @param slug - A validated worktree slug.
 * @returns the command to run.
 */
export function addWorktree(repoRoot: string, slug: string): GitCmd {
  const path = worktreePathFor(repoRoot, slug)
  return {
    command: `git worktree add -B ${quote(worktreeBranch(slug))} ${quote(path)} HEAD`,
    workdir: repoRoot,
    label: `create worktree "${path}"`,
  }
}

/**
 * `git worktree remove --force <path>`: git's force flag removes a dirty or
 * committed-on worktree. Callers gate `--force` on an explicit
 * `discard_changes` grant; this command is constructed only for that path.
 * @param repoRoot - The canonical repository root.
 * @param path - Absolute worktree path (must be a registered worktree).
 * @returns the command to run.
 */
export function forceRemoveWorktree(repoRoot: string, path: string): GitCmd {
  return {
    command: `git worktree remove --force ${quote(path)}`,
    workdir: repoRoot,
    label: `remove worktree "${path}"`,
  }
}

/**
 * `git branch -D <branch>` to delete the now-unregistered worktree branch.
 * @param repoRoot - The canonical repository root.
 * @param branch - Worktree branch to delete.
 * @returns the command to run.
 */
export function deleteBranch(repoRoot: string, branch: string): GitCmd {
  return {
    command: `git branch -D ${quote(branch)}`,
    workdir: repoRoot,
    label: `delete worktree branch "${branch}"`,
  }
}

/**
 * `git status --porcelain` inside the worktree — the working-tree dirtiness
 * probe for the remove gate.
 * @param worktreePath - Absolute worktree path.
 * @returns the command to run.
 */
export function status(worktreePath: string): GitCmd {
  return {
    command: 'git status --porcelain',
    workdir: worktreePath,
    label: `status "${worktreePath}"`,
  }
}

/**
 * `git rev-list --count <base>..HEAD` inside the worktree — the commit probe
 * for the remove gate.
 * @param worktreePath - Absolute worktree path.
 * @param originalHead - The commit the worktree was created from.
 * @returns the command to run.
 */
export function commitsAhead(worktreePath: string, originalHead: string): GitCmd {
  return {
    command: `git rev-list --count ${quote(`${originalHead}..HEAD`)}`,
    workdir: worktreePath,
    label: `count commits ahead of worktree "${worktreePath}"`,
  }
}

/**
 * Quote an argument for a `bash -c` command line using single-quote escaping.
 * @param arg - A path or ref to embed literally.
 * @returns the shell-quoted token.
 */
export function quote(arg: string): string {
  return `'${arg.replaceAll('\'', '\'\\\'\'')}'`
}

/** Human-readable for a repo — the basename of its canonical root. */
export function repoLabel(repoRoot: string): string {
  return basename(repoRoot)
}

/** A live EnterWorktree session for the current process. */
export interface WorktreeSession {
  /** The cwd of the session before EnterWorktree ran. */
  readonly originalCwd: string
  /** The session's canonical repository root (where `.claude/worktrees` lives). */
  readonly repoRoot: string
  /** Absolute on-disk worktree path. */
  readonly worktreePath: string
  /** The worktree branch name. */
  readonly worktreeBranch: string
  /** The commit the worktree was based on (the remove gate's baseline). */
  readonly originalHead: string
}

/**
 * The single active worktree session for this process, mirroring the
 * claude-code reference's module-level singleton. EnterWorktree sets it;
 * ExitWorktree clears it. This is intentionally process-wide (not per-session)
 * to match the reference and keep systemPrompt context injection unambiguous.
 */
let currentSession: WorktreeSession | null = null

/** The active worktree session, or `null` when not inside one. */
export function getActiveWorktreeSession(): WorktreeSession | null {
  return currentSession
}

/** Set the active worktree session. @internal */
export function setActiveWorktreeSession(session: WorktreeSession): void {
  currentSession = session
}

/** Clear the active worktree session. @internal */
export function clearActiveWorktreeSession(): void {
  currentSession = null
}

/** A base repo name for default (random) worktree slugs. @internal */
const ADJECTIVES = ['swift', 'bright', 'calm', 'keen', 'bold'] as const
/** A base repo noun for default (random) worktree slugs. @internal */
const NOUNS = ['fox', 'owl', 'elm', 'oak', 'ray'] as const

/**
 * Generate a random, valid worktree slug in the style of the claude-code
 * reference (`swift-fox-8f3a`).
 * @returns a valid random slug.
 */
export function randomSlug(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  const suffix = Math.random().toString(36).slice(2, 6)
  return `${adjective}-${noun}-${suffix}`
}
