/**
 * WS-4 lifecycle helpers for the EnterWorktree path (§6 of
 * docs/plans/2026-09-14-cc-worktree-parity.md): `worktree.baseRef`
 * resolution and session lock command construction. Pure over an injected
 * `git` runner so tests drive the resolution table without spawning git.
 * @module @dsh-cc/tool-git-worktree/lifecycle
 */

import { quote } from './worktree.ts'

/** Lock-reason prefix marking dsh-cc-owned worktree locks (WS-4 sweep key). */
export const DSH_CC_LOCK_PREFIX = 'dsh-cc '

/** The lock reason for an EnterWorktree-created worktree. */
export function sessionLockReason(slug: string): string {
  return `dsh-cc session ${slug}`
}

/** `git worktree lock --reason=<reason> <path>`. */
export function lockWorktree(repoRoot: string, worktreePath: string, reason: string) {
  return {
    command: `git worktree lock --reason=${quote(reason)} ${quote(worktreePath)}`,
    workdir: repoRoot,
    label: `lock worktree "${worktreePath}"`,
  }
}

/** `git worktree unlock <path>` — release before keep-return or removal. */
export function unlockWorktree(repoRoot: string, worktreePath: string) {
  return {
    command: `git worktree unlock ${quote(worktreePath)}`,
    workdir: repoRoot,
    label: `unlock worktree "${worktreePath}"`,
  }
}

/**
 * Pre-2.15 git lacks `worktree lock/unlock`; an "unknown option" failure is
 * tolerated as a no-op (one-line warn) so the flow still works on old git.
 */
export function isUnknownOptionFailure(text: string): boolean {
  return /unknown option|unknown switch/i.test(text)
}

/** One git probe result; `ok:false` covers both spawn and nonzero exit. */
export interface GitProbe {
  readonly ok: boolean
  readonly stdout: string
}

/** Injectable runner: one git argv → probe result (never throws). */
export type GitRun = (argv: readonly string[]) => Promise<GitProbe>

/** How stale the cached `origin/HEAD` may be before a refresh fetch. */
export const FRESH_CACHE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Resolve the worktree base (WS-4 `worktree.baseRef`):
 * - `head` → the literal `HEAD` (today's behavior; inside a worktree it is
 *   that worktree's HEAD, matching CC).
 * - `fresh` → the cached `refs/remotes/origin/HEAD` symbolic ref. When the
 *   cached ref is unreadable or its reflog is older than 24h, refresh via
 *   `git fetch origin <default-branch>` (the runner applies the time cap);
 *   fallback chain: cached ref → local `HEAD` (no remote at all → `HEAD`).
 * Any probe error degrades to the next fallback — never throws.
 * @param params.baseRef - The configured mode.
 * @param params.git - The probe runner.
 * @param params.now - Current time (ms); injectable for tests.
 * @param params.onFetch - Notified when a refresh fetch runs (for logs/tests).
 * @returns the base to hand to `git worktree add`.
 */
export async function resolveBaseRef(params: {
  baseRef: 'fresh' | 'head'
  git: GitRun
  now?: number
  onFetch?: (defaultBranch: string) => void
}): Promise<string> {
  if (params.baseRef === 'head') return 'HEAD'
  const now = params.now ?? Date.now()
  const symbolic = await params.git(['symbolic-ref', 'refs/remotes/origin/HEAD'])
  if (!symbolic.ok) return 'HEAD'
  const ref = symbolic.stdout.trim()
  if (ref.length === 0) return 'HEAD'
  const defaultBranch = ref.replace(/^refs\/remotes\/[^/]+\//, '')
  const reflog = await params.git(['reflog', 'show', ref, '--format=%ct', '-n', '1'])
  const ageMs = reflog.ok ? now - Number.parseInt(reflog.stdout.trim(), 10) * 1000 : Number.NaN
  if (Number.isNaN(ageMs) || ageMs > FRESH_CACHE_WINDOW_MS) {
    params.onFetch?.(defaultBranch)
    await params.git(['fetch', 'origin', defaultBranch])
  }
  return ref
}
