/**
 * Resumed-cwd guard (slice 2 of the exit-resume-tip design): a resumed
 * session adopts its stored header cwd, which may have been deleted since
 * (e.g. a removed worktree). There is no harness `resume({ meta })` cwd
 * override, so instead of a CC-parity fallback we surface a prominent notice
 * and keep the resumed transcript — the user decides.
 *
 * @module @dsh-cc/tui/harness/resumed-cwd-guard
 */

import { existsSync } from 'node:fs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { liveSessionCwd } from './driver-live.ts'

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
  if (guard === undefined) return
  showNotice(
    `会话原目录已不存在：${guard.missingCwd}。文件工具可能失败，建议 /clear 开启新会话，或在正确目录中重启`,
  )
}
