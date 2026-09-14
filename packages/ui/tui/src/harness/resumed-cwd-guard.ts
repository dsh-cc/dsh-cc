/**
 * Resume-cwd guard (WS-5 item 2 of docs/plans/2026-09-14-cc-worktree-parity.md):
 * turns a worktree-identity verdict on a resumed session's stored cwd into a
 * user-facing notice. Fail-open by design — every refusal class warns and
 * STAYS in the launch directory, because the true fallback (resume into the
 * launch dir + clear the persisted binding) needs the upstream
 * `resume({ meta })` seam (plan §11.3). Notice taxonomy mirrors CC:
 * refusing-to-use vs could-not-verify vs plain missing directory.
 *
 * @module @dsh-cc/tui/harness/resumed-cwd-guard
 */

import { worktreeIdentityVerdict } from './worktree-identity.ts'

/**
 * The notice to surface for a resumed session's stored cwd, or undefined
 * when the cwd is present and (for worktree cwds) identity-verified.
 */
export function warnIfResumedCwdMissing(storedCwd: string, launchCwd: string): string | undefined {
  const verdict = worktreeIdentityVerdict(storedCwd, launchCwd)
  switch (verdict.kind) {
    case 'ok':
      return undefined
    case 'missing':
      return `上次会话的工作目录已不存在：${storedCwd}。已留在当前目录。`
    case 'refused':
      return `已拒绝进入 ${storedCwd}：${verdict.reason}。已留在当前目录。`
    case 'unverified':
      return `暂时无法验证 ${storedCwd}，重试 resume 可再次尝试。已留在当前目录。`
  }
}
