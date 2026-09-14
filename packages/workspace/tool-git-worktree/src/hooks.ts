/**
 * WS-6 WorktreeCreate/WorktreeRemove hook invocation (§6 item 2): thin
 * adapters over the bridge's `hookRun` invoke seam. Every adapter degrades to
 * the caller's default behavior when no hooks bridge is mounted, when no hook
 * matched, or (for create) when a hook exits non-zero — CC parity: a failing
 * create hook falls back to git-direct creation and a failing remove hook
 * keeps the tree.
 * @module @dsh-cc/tool-git-worktree/hooks
 */

import { existsSync, statSync } from 'node:fs'
import { adoptionRefusal } from './harden.ts'
import { probeInsideRepo } from './pathform.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { HookOutput } from '@dsh-cc/hook-protocol'

/** WorktreeCreate payload `source` values (CC-shape parity; see manifest). */
export type WorktreeCreateSource = 'worktree-flag' | 'enter-worktree' | 'subagent-isolation'
/** WorktreeRemove payload `reason` values. */
export type WorktreeRemoveReason = 'exit' | 'subagent-finished' | 'sweep'

export interface WorktreeCreateFields {
  sessionId: string
  cwd: string
  name: string
  worktreePath: string
  branch: string
  source: WorktreeCreateSource
}

export interface WorktreeRemoveFields {
  sessionId: string
  cwd: string
  worktreePath: string
  reason: WorktreeRemoveReason
}

/** Whether any hook actually matched and ran (empty outputs = no hook). */
function hasHooks(outputs: readonly HookOutput[]): boolean {
  return outputs.length > 0
}

/** A hook run failed: non-zero exit, a spawn failure, or a timeout. */
function failed(output: HookOutput): boolean {
  return output.exitCode === undefined || output.exitCode !== 0 || output.timedOut === true
}

/** The default (no hook mounted / no hook matched) create outcome. */
export const CREATE_DEFAULT = { kind: 'default' } as const

export type WorktreeCreateOutcome =
  | typeof CREATE_DEFAULT
  | { kind: 'adopt'; path: string }

/**
 * Fire the WorktreeCreate point. Returns `{ kind: 'adopt', path }` only when a
 * hook exited 0 with a non-empty stdout path that passes adoption
 * verification: the path must exist as a directory, pass the WS-1 identity
 * check, and — CC parity — a directory WITHOUT git metadata is accepted only
 * when no git repository contains it (verified with a `git rev-parse` probe).
 * A non-zero hook exit falls back to git-direct creation.
 */
export async function runWorktreeCreateHook(
  ctx: Context,
  fields: WorktreeCreateFields,
  opts: { mainRoot: string; signal: AbortSignal },
): Promise<WorktreeCreateOutcome> {
  const { signal } = opts
  const hookRun = ctx.get?.('hookRun')
  if (hookRun === undefined) return CREATE_DEFAULT
  const result = await hookRun('WorktreeCreate', { ...fields }, { signal })
  if (!hasHooks(result.outputs)) return CREATE_DEFAULT
  if (result.outputs.some(failed)) return CREATE_DEFAULT
  const path = result.outputs
    .map(output => output.stdout.trim().split('\n')[0]?.trim() ?? '')
    .find(candidate => candidate.length > 0)
  if (path === undefined) return CREATE_DEFAULT
  if (!existsSync(path) || !statSync(path).isDirectory()) return CREATE_DEFAULT
  const refusal = adoptionRefusal(path, opts.mainRoot)
  if (refusal !== null) {
    // The WS-1 identity check refused. The only tolerated shape is a
    // hook-created directory with no git metadata, accepted solely when no
    // git repository contains it.
    if (!refusal.includes('no git worktree (no .git entry)')) return CREATE_DEFAULT
    const insideRepo = await probeInsideRepo(ctx, path, signal)
    if (insideRepo) return CREATE_DEFAULT
  }
  return { kind: 'adopt', path }
}

/** WorktreeRemove decision: default removal, hook replaced it, or hook failed. */
export type WorktreeRemoveOutcome = 'default' | 'replaced' | 'kept'

/**
 * Fire the WorktreeRemove point. `'replaced'` means every matched hook exited
 * 0 — the caller skips its default removal. `'kept'` means a hook failed and
 * the tree must stay. `'default'` means no hook ran.
 */
export async function runWorktreeRemoveHook(
  ctx: Context,
  fields: WorktreeRemoveFields,
  signal: AbortSignal,
): Promise<WorktreeRemoveOutcome> {
  const hookRun = ctx.get?.('hookRun')
  if (hookRun === undefined) return 'default'
  const result = await hookRun('WorktreeRemove', { ...fields }, { signal })
  if (!hasHooks(result.outputs)) return 'default'
  return result.outputs.some(failed) ? 'kept' : 'replaced'
}
