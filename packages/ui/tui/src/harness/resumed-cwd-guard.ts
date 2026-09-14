/**
 * Resumed-cwd guard (slice 2 of the exit-resume-tip design): a resumed
 * session adopts its stored header cwd, which may have been deleted since
 * (e.g. a removed worktree). There is no harness `resume({ meta })` cwd
 * override, so instead of a CC-parity fallback we surface a prominent notice
 * and keep the resumed transcript — the user decides. It also hosts the
 * worktree tombstone pair: clearing the project resume anchor when its
 * session's worktree is removed, and gating boot auto-resume on the anchored
 * session's persisted cwd still existing (both fail-open).
 *
 * @module @dsh-cc/tui/harness/resumed-cwd-guard
 */

import { existsSync } from 'node:fs'
import { resolve as resolvePath, sep } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { liveSessionCwd } from './driver-live.ts'
import { clearResumeTarget, readResumeTarget } from '../resume-target.ts'
import { worktreeIdentityVerdict } from './worktree-identity.ts'
import type { PersistenceLike } from './session-service-likes.ts'

/**
 * Resolve the session's live cwd and report it when the directory no longer
 * exists. `undefined` means the cwd is fine (or falls back to launchCwd).
 */
export function resumedCwdGuard(agent: Agent, launchCwd: string): { missingCwd: string } | undefined {
  const sessionCwd = liveSessionCwd(agent, launchCwd)
  return existsSync(sessionCwd) ? undefined : { missingCwd: sessionCwd }
}

/** Emit the missing-cwd notice through `showNotice` when the guard fires. */
export function warnIfResumedCwdMissing(
  agent: Agent,
  launchCwd: string,
  showNotice: (message: string) => void,
): void {
  const guard = resumedCwdGuard(agent, launchCwd)
  if (guard !== undefined) {
    showNotice(
      `会话原目录已不存在：${guard.missingCwd}。文件工具可能失败，建议 /clear 开启新会话，或在正确目录中重启`,
    )
    return
  }
  // WS-5 fold: an existing worktree-shaped cwd still needs identity
  // verification before the session settles in it. Fail-open: notice + stay.
  const sessionCwd = liveSessionCwd(agent, launchCwd)
  const verdict = worktreeIdentityVerdict(sessionCwd, launchCwd)
  if (verdict.kind === 'refused') {
    showNotice(
      `已拒绝进入原 worktree：${sessionCwd}（${verdict.reason}）。会话将在当前目录继续，文件操作可能指向主检目录`,
    )
  } else if (verdict.kind === 'unverified') {
    showNotice(
      `暂时无法验证原 worktree：${sessionCwd}。会话已在当前目录继续；重试 resume 可再次尝试`,
    )
  }
}

/**
 * Tombstone the project resume anchor for a removed worktree. The anchor is
 * only cleared when the anchored session's persisted header cwd resolves
 * inside `removedPath` (segment-boundary safe); any failure — no anchor, no
 * persistence, list() throwing, unknown id, missing header cwd — fails open
 * and leaves the anchor untouched.
 */
export async function tombstoneResumeTargetForRemovedWorktree(opts: {
  /** Any directory inside the repository (collapsed to the project root by resolveProject). */
  cwd: string
  /** Absolute path of the removed worktree. */
  removedPath: string
  /** `undefined` → fail-open. */
  persistence?: PersistenceLike | undefined
}): Promise<{ cleared: boolean; sessionId?: string }> {
  const sessionId = readResumeTarget({ cwd: opts.cwd })
  if (sessionId === undefined) return { cleared: false }
  const removed = resolvePath(opts.removedPath)
  let stored: string | undefined
  try {
    const snapshots = opts.persistence === undefined ? [] : await opts.persistence.list()
    stored = snapshots.find((s) => s.header.id === sessionId)?.header.cwd
  } catch {
    return { cleared: false }
  }
  if (stored === undefined) return { cleared: false }
  const storedPath = resolvePath(stored)
  const inside = storedPath === removed || storedPath.startsWith(removed + sep)
  if (!inside) return { cleared: false }
  clearResumeTarget({ cwd: opts.cwd })
  return { cleared: true, sessionId }
}

/**
 * Boot gate for the auto-resume branch: when the anchored session's persisted
 * header cwd no longer exists, clear the anchor and degrade to a fresh
 * session with a notice. Any fail-open case (no persistence, list() throwing,
 * unknown id, missing header cwd) resumes untouched.
 */
export async function gateAutoResumeTarget(opts: {
  markerId: string
  persistence?: PersistenceLike | undefined
  showNotice: (message: string) => void
  /** Project cwd the anchor is keyed by (clear path). */
  cwd: string
}): Promise<'resume' | 'fresh'> {
  let stored: string | undefined
  try {
    const snapshots = opts.persistence === undefined ? [] : await opts.persistence.list()
    stored = snapshots.find((s) => s.header.id === opts.markerId)?.header.cwd
  } catch {
    return 'resume'
  }
  if (stored === undefined || existsSync(stored)) return 'resume'
  clearResumeTarget({ cwd: opts.cwd })
  opts.showNotice(
    `上次会话目录已不存在：${stored}。已开启新会话；可用 /resume 找回旧会话。`,
  )
  return 'fresh'
}
