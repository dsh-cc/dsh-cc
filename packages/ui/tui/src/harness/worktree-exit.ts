/**
 * `/quit` worktree cleanup support: detect whether the session cwd is a git
 * worktree this deployment manages, gather removal evidence, and perform the
 * removal. Everything runs through an injectable exec so tests never spawn
 * git.
 *
 * Slug/path/branch conventions mirror
 * `packages/workspace/tool-git-worktree/src/worktree.ts` and the launcher's
 * `packages/launcher/tui/bootstrap.mjs` (`--worktree` flag) — keep all three
 * in sync.
 *
 * @module @dsh-cc/tui/harness/worktree-exit
 */

import { execFile } from 'node:child_process'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Env var the launcher sets when it created the session's worktree via
 * `--worktree`. Mirrors `WORKTREE_ENV` in packages/launcher/tui/bootstrap.mjs.
 */
export const WORKTREE_ENV = 'DSH_CC_WORKTREE'

/** Branch prefix marking dsh-cc-owned worktree branches. */
export const WORKTREE_BRANCH_PREFIX = 'worktree-'

/** A successful git invocation. */
export interface WorktreeExecResult {
  stdout: string
  stderr: string
}

/**
 * Run one git argv in `cwd`. Rejects on non-zero exit or spawn failure.
 * Injectable so tests script the git conversation.
 */
export type WorktreeExec = (argv: readonly string[], cwd: string) => Promise<WorktreeExecResult>

/** The default exec: real `git` via execFile (no shell). */
export const gitExec: WorktreeExec = async (argv, cwd) => {
  const { stdout, stderr } = await execFileAsync('git', [...argv], {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
  })
  return { stdout, stderr }
}

/** A session recognized as running inside a worktree. */
export interface WorktreeExitSession {
  /**
   * `managed`: created by the launcher's `--worktree` (env marker verified
   * against the live cwd; carries `baseHead` and a guaranteed owned branch).
   * `detected`: the session cwd happens to sit under a repo's
   * `.claude/worktrees/` convention directory without a launcher marker.
   */
  readonly kind: 'managed' | 'detected'
  /** Canonical repository root (where `.claude/worktrees` lives). */
  readonly repoRoot: string
  /** Absolute worktree path (the session cwd). */
  readonly worktreePath: string
  /** The branch checked out in the worktree. */
  readonly branch: string
  /** Managed sessions only: the commit the worktree was created from. */
  readonly baseHead?: string
  /**
   * Managed sessions only (WS-4 marker field): the slug was user-chosen.
   * WS-5's auto-remove predicate consumes this; parsed here so the marker
   * writer/parsers stay in sync.
   */
  readonly named?: boolean
}

/** Removal evidence shown in the exit overlay before the user confirms. */
export interface WorktreeExitEvidence {
  /** Uncommitted changes (porcelain line count); undefined when unreadable. */
  readonly dirtyFiles?: number
  /** Managed sessions only: commits on the worktree branch past baseHead. */
  readonly commitsAhead?: number
}

/** Outcome of a successful removal. */
export interface WorktreeCleanupOutcome {
  /** Whether the backing branch was deleted (owned branches only). */
  readonly branchDeleted: boolean
}

/** The injectable seam consumed by the driver; production wires gitExec. */
export interface WorktreeExitHooks {
  probe(cwd: string): Promise<WorktreeExitSession | undefined>
  evidence(session: WorktreeExitSession): Promise<WorktreeExitEvidence>
  cleanup(session: WorktreeExitSession): Promise<WorktreeCleanupOutcome>
  /** Best-effort `git worktree unlock` (WS-4); never throws. */
  unlock(session: WorktreeExitSession): Promise<void>
}

/** Parse the launcher's env marker; garbage is treated as absent. */
function parseMarker(raw: string | undefined): Omit<WorktreeExitSession, 'kind'> | undefined {
  if (raw === undefined || raw.length === 0) return undefined
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed.repoRoot !== 'string' || typeof parsed.worktreePath !== 'string'
      || typeof parsed.branch !== 'string') {
      return undefined
    }
    return {
      repoRoot: parsed.repoRoot,
      worktreePath: parsed.worktreePath,
      branch: parsed.branch,
      ...(typeof parsed.baseHead === 'string' && parsed.baseHead.length > 0
        ? { baseHead: parsed.baseHead }
        : {}),
      ...(parsed.named === true ? { named: true } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * Recognize a worktree session for `/quit`. Env marker first (it must match
 * the live cwd — an inherited marker in a subprocess running elsewhere is
 * ignored); otherwise probe git: the session top-level must sit under the
 * main checkout's `.claude/worktrees/` directory. Anything else (main
 * checkout, user-managed worktrees outside the convention dir, non-git
 * cwd) returns undefined and `/quit` keeps its plain behavior.
 */
export async function detectWorktreeSession(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  exec: WorktreeExec = gitExec,
): Promise<WorktreeExitSession | undefined> {
  const marker = parseMarker(env[WORKTREE_ENV])
  if (marker !== undefined && resolve(marker.worktreePath) === resolve(cwd)) {
    return { kind: 'managed', ...marker }
  }
  let top: string
  let commonDir: string
  try {
    top = (await exec(['rev-parse', '--show-toplevel'], cwd)).stdout.trim()
    commonDir = (await exec(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)).stdout.trim()
  } catch {
    return undefined
  }
  // The common dir of a standard layout is `<mainRoot>/.git`; anything else
  // (bare repo, exotic GIT_DIR) is not ours to reason about.
  if (!commonDir.endsWith(`${sep}.git`)) return undefined
  const mainRoot = dirname(commonDir)
  if (resolve(top) === resolve(mainRoot)) return undefined
  const conventionDir = join(mainRoot, '.claude', 'worktrees')
  if (!resolve(top).startsWith(conventionDir + sep)) return undefined
  let branch = ''
  try {
    branch = (await exec(['rev-parse', '--abbrev-ref', 'HEAD'], top)).stdout.trim()
  } catch {
    return undefined
  }
  return { kind: 'detected', repoRoot: mainRoot, worktreePath: top, branch }
}

/**
 * Count uncommitted changes and (managed only) commits ahead of the base.
 * Best-effort: an unreadable dimension is reported as undefined rather than
 * failing the prompt — the user's confirmation is the removal grant.
 */
export async function gatherEvidence(
  session: WorktreeExitSession,
  exec: WorktreeExec = gitExec,
): Promise<WorktreeExitEvidence> {
  let dirtyFiles: number | undefined
  try {
    const status = await exec(['status', '--porcelain'], session.worktreePath)
    dirtyFiles = status.stdout.split('\n').filter(line => line.trim().length > 0).length
  } catch {
    dirtyFiles = undefined
  }
  let commitsAhead: number | undefined
  if (session.baseHead !== undefined) {
    try {
      const revs = await exec(['rev-list', '--count', `${session.baseHead}..HEAD`], session.worktreePath)
      const parsed = Number.parseInt(revs.stdout.trim(), 10)
      commitsAhead = Number.isNaN(parsed) ? undefined : parsed
    } catch {
      commitsAhead = undefined
    }
  }
  return {
    ...(dirtyFiles === undefined ? {} : { dirtyFiles }),
    ...(commitsAhead === undefined ? {} : { commitsAhead }),
  }
}

/**
 * Whether the removal may also delete the backing branch. Managed sessions
 * always own theirs; detected sessions only when the branch follows the
 * `worktree-` convention (never a user's own branch).
 */
export function ownsBranch(session: WorktreeExitSession): boolean {
  return session.kind === 'managed' || session.branch.startsWith(WORKTREE_BRANCH_PREFIX)
}

/**
 * WS-5 auto-remove predicate (CC's unnamed-session rule): a managed launcher
 * session with no user-pinned name and a fully readable, fully clean evidence
 * probe is removed silently on `/quit`, without the overlay. Any unreadable
 * probe dimension (undefined) fails closed — the overlay decides instead.
 */
export function autoRemovable(session: WorktreeExitSession, evidence: WorktreeExitEvidence): boolean {
  return session.kind === 'managed' && session.named !== true
    && evidence.dirtyFiles === 0 && evidence.commitsAhead === 0
}

/**
 * Best-effort `git worktree unlock` (WS-4): release the session lock at
 * TUI dispose for recognized sessions. Any failure — including pre-2.15
 * git without `worktree lock` — is swallowed; quitting must not fail.
 */
export async function unlockWorktreeSession(
  session: WorktreeExitSession,
  exec: WorktreeExec = gitExec,
): Promise<void> {
  try {
    await exec(['worktree', 'unlock', session.worktreePath], session.repoRoot)
  } catch {
    // Pre-2.15 git or a foreign lock: quitting proceeds regardless.
  }
}

/**
 * Remove the worktree directory and (when owned) its branch. The branch
 * delete runs only after the worktree remove succeeds — git refuses to
 * delete a branch checked out in a registered worktree, and a failed remove
 * must not escalate into a branch delete. A failed branch delete after a
 * successful remove is lint residue, not a failure: reported, not thrown.
 *
 * The process first chdirs to the repo root (via the injectable `chdir` —
 * tests pass a no-op): the session cwd lives inside the directory being
 * removed, and anything touching cwd between removal and process exit would
 * otherwise fail.
 */
export async function removeWorktree(
  session: WorktreeExitSession,
  exec: WorktreeExec = gitExec,
  chdir: (dir: string) => void = dir => process.chdir(dir),
): Promise<WorktreeCleanupOutcome> {
  chdir(session.repoRoot)
  // WS-4: release the session lock first — git refuses to remove a locked
  // worktree. Failure is tolerated (pre-2.15 git / foreign lock).
  try {
    await exec(['worktree', 'unlock', session.worktreePath], session.repoRoot)
  } catch {
    // Unlock is advisory; the removal below is the real gate.
  }
  await exec(['worktree', 'remove', '--force', session.worktreePath], session.repoRoot)
  if (!ownsBranch(session)) return { branchDeleted: false }
  try {
    await exec(['branch', '-D', session.branch], session.repoRoot)
    return { branchDeleted: true }
  } catch {
    return { branchDeleted: false }
  }
}

/** The production hook set backed by real git. */
export function createWorktreeExitHooks(env: NodeJS.ProcessEnv = process.env): WorktreeExitHooks {
  return {
    probe: cwd => detectWorktreeSession(cwd, env, gitExec),
    evidence: session => gatherEvidence(session, gitExec),
    cleanup: session => removeWorktree(session, gitExec),
    unlock: session => unlockWorktreeSession(session, gitExec),
  }
}
