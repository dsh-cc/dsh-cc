/**
 * Shared execution plumbing for the git-worktree tools (extracted from
 * index.ts for the 500-line budget): session-cwd propagation, the
 * `ctx.shell` git runner, path/identity asserts, change probes, and the
 * WS-4 lock release. Pure plumbing — the tool definitions live in index.ts.
 * @module @dsh-cc/tool-git-worktree/exec
 */

import type { Context } from '@deepseek-ai/cordis'
import { relative, sep } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { TOOL_ABORTED } from '@dsh-cc/tools'
import type { ToolRunContext } from '@dsh-cc/tools'
import { setSessionCwd } from '@dsh-cc/session-cwd'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import { repoRootFromCommonDir } from './harden.ts'
import type { IncludeGit } from './include.ts'
import { unlockWorktree } from './lifecycle.ts'
import { commitsAhead, status } from './worktree.ts'
import type { GitCmd, WorktreeSession } from './worktree.ts'

/** A structured, model-visible failure (maps to an isError tool result). */
class WorktreeError extends Error {}

export function sessionCwd(exec: ToolRunContext): string | undefined {
  return exec.agent?.session.header.cwd
}

/**
 * Propagate a cwd change into the session-cwd plugin (WS1): a durable
 * `worktree/entered` event plus the live overlay. Tolerant of test fakes and
 * headless contexts whose session face lacks the append seam — the tool must
 * not fail because a non-persistent session cannot record the move.
 * @param exec - the running tool call.
 * @param path - the new absolute session working directory.
 */
export function updateSessionCwd(exec: ToolRunContext, path: string): void {
  const agent = exec.agent
  if (agent === undefined) return
  const session = agent.session as unknown as { append?: unknown } | undefined
  if (session === undefined || typeof session.append !== 'function') return
  // Fail-soft: a session that cannot persist the event still completes the
  // worktree operation; the worktree session singleton remains authoritative.
  try {
    setSessionCwd(agent, path)
  } catch {
    // cwd bookkeeping is best-effort here.
  }
}

/**
 * Run one git command to completion through the `ctx.shell` seam. Resolves a
 * fresh request (never passing an unresolved one to `run`) and maps abort /
 * spawn failures to a structured {@link HarnessError}; a nonzero git exit
 * resolves normally for the caller to interpret.
 * @param ctx - the Cordis context.
 * @param cmd - the constructed git command.
 * @param signal - the tool-call cancellation signal.
 * @returns the shell result, with `exitCode` nonzero representing a git-level failure.
 */
export async function runGit(
  ctx: Context,
  cmd: GitCmd,
  signal: AbortSignal,
): Promise<ShellRunResult> {
  const result = await ctx.shell.run(ctx.shell.resolve({
    command: cmd.command,
    workdir: cmd.workdir,
    signal,
  }))
  if (result.aborted) {
    const error = new HarnessError('tool call aborted', TOOL_ABORTED)
    error.name = 'AbortError'
    throw error
  }
  return result
}

/** Truncated stderr tail used to surface git failure causes in messages. */
export function gitFailure(result: ShellRunResult): string {
  return result.stderr.text.trim() || result.stdout.text.trim() || `exit code ${result.exitCode}`
}

/**
 * Assert a computed worktree path is contained by this repo's `worktrees`
 * directory. All paths a tool will act on are validated here before any git
 * command runs.
 * @param ctx - the Cordis context.
 * @param repoRoot - the canonical repository root.
 * @param worktreePath - candidate absolute worktree path.
 */
export async function assertPathInRepo(ctx: Context, repoRoot: string, worktreePath: string): Promise<void> {
  if (relative(repoRoot, worktreePath).startsWith(`..${sep}`)) {
    throw new WorktreeError(`refusing worktree path outside the repository: "${worktreePath}"`)
  }
  const rootTarget = await ctx.fs.resolve(repoRoot)
  const pathTarget = await ctx.fs.resolve(worktreePath)
  if (!ctx.fs.contains(rootTarget, pathTarget)) {
    throw new WorktreeError(`refusing worktree path outside the repository: "${worktreePath}"`)
  }
}

/**
 * Find the main repository root for a working directory using git, pinned to
 * the git common dir (WS-1): `--git-common-dir` already returns the main
 * checkout's `.git` from inside a linked worktree, so creation always
 * anchors at the main root (sibling worktrees, never nested).
 * @param ctx - the Cordis context.
 * @param cwd - the working directory to search from.
 * @param signal - the tool-call cancellation signal.
 * @returns the main repository root, or `undefined` when not a git repository.
 */
export async function findRepoRoot(ctx: Context, cwd: string, signal: AbortSignal): Promise<string | undefined> {
  const result = await runGit(
    ctx,
    { command: 'git rev-parse --git-common-dir', workdir: cwd, label: 'locate repository common dir' },
    signal,
  )
  return result.exitCode === 0 ? repoRootFromCommonDir(cwd, result.stdout.text) : undefined
}

/**
 * Refuse creation when a path on the creation route (`.claude`,
 * `.claude/worktrees`, the target) is itself a symlink — `ctx.fs.resolve`
 * follows symlinks, so the containment assert above cannot see them.
 * @param ctx - the Cordis context.
 * @param path - the candidate path.
 * @param what - human label used in the error.
 */
export async function assertNotSymlink(ctx: Context, path: string, what: string): Promise<void> {
  const info = await ctx.fs.lstat(path)
  if (info?.type === 'symlink') {
    throw new WorktreeError(`refusing worktree path: ${what} is a symlink: "${path}"`)
  }
}

/**
 * Probe whether the (remove-gate) worktree currently differs from the commit it
 * was created from, counting both uncommitted files and new commits. Returns
 * `null` when the state cannot be determined reliably — callers treat that as
 * "unknown, assume unsafe" (fail-closed) so a silent 0/0 can never let a remove
 * destroy real work.
 * @param ctx - the Cordis context.
 * @param session - the active worktree session.
 * @returns the change counts, or `null` when unknown.
 */
export async function countWorktreeChanges(
  ctx: Context,
  session: WorktreeSession,
  signal: AbortSignal,
): Promise<{ changedFiles: number; commits: number } | null> {
  const statusResult = await runGit(ctx, status(session.worktreePath), signal)
  if (statusResult.exitCode !== 0) return null
  const changedFiles = statusResult.stdout.text.split('\n').filter(line => line.trim() !== '').length
  const revResult = await runGit(ctx, commitsAhead(session.worktreePath, session.originalHead), signal)
  if (revResult.exitCode !== 0) return null
  const commits = parseInt(revResult.stdout.text.trim(), 10) || 0
  return { changedFiles, commits }
}

/**
 * Best-effort `git worktree unlock` (WS-4): runs on both ExitWorktree
 * actions. Any failure — including pre-2.15 git without `worktree lock` —
 * is a one-line warn, never an error.
 */
export async function releaseLock(ctx: Context, session: WorktreeSession, signal: AbortSignal): Promise<void> {
  const unlock = await runGit(ctx, unlockWorktree(session.repoRoot, session.worktreePath), signal)
  if (unlock.exitCode !== 0) {
    ctx.logger.warn(`could not unlock worktree ${session.worktreePath}: ${gitFailure(unlock)}`)
  }
}

/**
 * WS-6: adapt `ctx.shell` to the `.worktreeinclude` copy step's injectable
 * runner. Spawn failures return `undefined` (the copy step degrades);
 * an abort still propagates.
 */
export function includeGitRunner(ctx: Context, signal: AbortSignal): IncludeGit {
  return async (command, workdir) => {
    try {
      const result = await runGit(ctx, { command, workdir, label: command }, signal)
      return { status: result.exitCode, stdout: result.stdout.text }
    } catch (error) {
      if ((error as { name?: unknown }).name === 'AbortError') throw error
      return undefined
    }
  }
}
