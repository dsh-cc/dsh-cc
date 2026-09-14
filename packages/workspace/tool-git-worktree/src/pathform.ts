/**
 * WS-6 item 4 — the EnterWorktree `path` form: adopt an existing directory
 * instead of creating one. Under the repository's `.claude/worktrees/` the
 * adoption is direct (after the WS-1 identity check); anywhere else the call
 * goes through the approval seam with an ask that ALWAYS fires — the TUI
 * never derives a persisted "don't ask again" rule for EnterWorktree, so only
 * bypassPermissions mode skips it (CC v2.1.206 parity). Within an active
 * worktree session the path must stay under the same repository's worktrees
 * directory (recorded divergence: `name` creation stays legal there too).
 * @module @dsh-cc/tool-git-worktree/pathform
 */

import { isAbsolute, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ToolRunContext } from '@dsh-cc/tools'
import { readPermissionMode } from '@dsh-cc/session-cwd'
import { adoptionRefusal } from './harden.ts'
import { worktreesDir } from './worktree.ts'

/** A structured, model-visible failure (maps to an isError tool result). */
export class PathFormError extends Error {}

function isInside(parent: string, child: string): boolean {
  return child.startsWith(parent + sep) || child === parent
}

/**
 * Resolve the raw `path` argument against the session cwd and enforce the
 * from-within-a-worktree constraint.
 * @returns the absolute candidate path (not verified to exist).
 */
export function resolvePathArgument(raw: string, cwd: string, activeRepoRoot: string | null): string {
  const candidate = resolve(isAbsolute(raw) ? raw : resolve(cwd, raw))
  if (activeRepoRoot !== null && !isInside(worktreesDir(activeRepoRoot), candidate)) {
    throw new PathFormError(
      `refusing path ${candidate}: from within a worktree session, the path form must stay under `
      + `${worktreesDir(activeRepoRoot)}. Use ExitWorktree first, or create by name.`,
    )
  }
  return candidate
}

/**
 * Is `path` inside any git repository (`git rev-parse --show-toplevel`)?
 * Injectable-free probe over ctx.shell; failure means "no".
 */
export async function probeInsideRepo(ctx: Context, path: string, signal: AbortSignal): Promise<boolean> {
  try {
    const result = await ctx.shell.run(ctx.shell.resolve({
      command: 'git rev-parse --show-toplevel',
      workdir: path,
      signal,
    }))
    return !result.aborted && result.exitCode === 0
  } catch {
    return false
  }
}

/**
 * The adoption decision for one resolved candidate path. `underConvention`
 * paths adopt directly after the WS-1 identity check; anything else requires
 * the always-ask (unless bypassPermissions) and additionally tolerates a
 * metadata-less directory only when no git repository contains it.
 * @returns the absolute path to adopt; throws {@link PathFormError} on refusal,
 *   a missing/non-directory target, or a denied/absent approval.
 */
export async function resolveAdoptPath(
  ctx: Context,
  exec: ToolRunContext,
  args: { rawPath: string; cwd: string; repoRoot: string },
): Promise<string> {
  const { cwd, repoRoot } = args
  const candidate = resolvePathArgument(args.rawPath, cwd, null)
  let info
  try {
    info = await ctx.fs.lstat(candidate)
  } catch {
    info = undefined
  }
  if (info === undefined || info.type !== 'directory') {
    throw new PathFormError(
      `cannot adopt ${candidate}: the path does not exist or is not a directory.`,
    )
  }

  const conventionDir = worktreesDir(repoRoot)
  const underConvention = isInside(conventionDir, candidate)
  if (underConvention) {
    const refusal = adoptionRefusal(candidate, repoRoot)
    if (refusal !== null) throw new PathFormError(refusal)
    return candidate
  }

  // Outside the convention directory: an ask that ALWAYS fires. bypassPermissions
  // is the only bypass; permission persistence ("don't ask again") never
  // suppresses it — the TUI derives no persisted rule for EnterWorktree.
  const mode = exec.agent !== undefined
    ? readPermissionMode(exec.agent.session.snapshotEvents())
    : undefined
  if (mode !== 'bypassPermissions') {
    const approval = ctx.get('approval')
    if (approval === undefined || exec.agent === undefined) {
      throw new PathFormError(
        `refusing to adopt ${candidate}: it is outside ${conventionDir} and no approval channel is `
        + 'available to confirm the adoption. Move the directory under .claude/worktrees/ first.',
      )
    }
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: 'EnterWorktree',
      callId: exec.callId,
      reason: `EnterWorktree wants to adopt the directory ${candidate}, which is OUTSIDE the repository's `
        + `${conventionDir}. This prompt always fires — "don't ask again" cannot suppress it.`,
      signal: exec.signal,
    })
    if (outcome !== 'allowed-once') {
      throw new PathFormError(`the user did not approve adopting ${candidate} (outside the worktrees directory).`)
    }
  }

  // Post-ask identity check: WS-1 refusals stand, except a metadata-less
  // directory is acceptable only when no git repository contains it.
  const refusal = adoptionRefusal(candidate, repoRoot)
  if (refusal !== null) {
    if (!refusal.includes('no .git entry')) throw new PathFormError(refusal)
    if (await probeInsideRepo(ctx, candidate, exec.signal)) {
      throw new PathFormError(refusal)
    }
  }
  return candidate
}

/** Resolve the HEAD commit inside an adopted path ('' when it has none). */
export async function headOfAdopted(ctx: Context, path: string, signal: AbortSignal): Promise<string> {
  try {
    const result = await ctx.shell.run(ctx.shell.resolve({
      command: 'git rev-parse HEAD',
      workdir: path,
      signal,
    }))
    return !result.aborted && result.exitCode === 0 ? result.stdout.text.trim() : ''
  } catch {
    return ''
  }
}

/** Resolve the checked-out branch inside an adopted path ('' when unreadable). */
export async function branchOfAdopted(ctx: Context, path: string, signal: AbortSignal): Promise<string> {
  try {
    const result = await ctx.shell.run(ctx.shell.resolve({
      command: 'git branch --show-current',
      workdir: path,
      signal,
    }))
    return !result.aborted && result.exitCode === 0 ? result.stdout.text.trim() : ''
  } catch {
    return ''
  }
}
