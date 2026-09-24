/**
 * Durable default-mode pinning for freshly created sessions: when the
 * deployment default is a sandbox-affecting or plan mode, a new session
 * inherits it as a durable session event. Extracted for the file-size budget.
 *
 * @module @dsh-cc/permission-rules/default-mode-pin
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { foldPlanMode, foldPermissionMode, foldSandboxMode, setPermissionMode } from './mode.ts'
import type { PermissionMode } from './types.ts'

/**
 * Pin `session` to the deployment `defaultMode` unless it already carries a
 * recorded mode or plan state. `bypassDisabled` skips the bypass pin;
 * `sandboxModeOf` resolves the shell's current sandbox for the resume record.
 */
export function pinDefaultMode(
  session: Session,
  defaultMode: PermissionMode,
  bypassDisabled: boolean,
  sandboxModeOf: () => SandboxMode | undefined,
): void {
  if (foldPermissionMode(session.snapshotEvents()) !== undefined) return
  if (foldPlanMode(session.snapshotEvents())) return
  if (defaultMode === 'bypassPermissions') {
    if (bypassDisabled) return
    const resume = foldSandboxMode(session.snapshotEvents()) ?? sandboxModeOf()
    setPermissionMode(session, 'bypassPermissions', resume)
    if ((foldSandboxMode(session.snapshotEvents()) ?? sandboxModeOf()) !== 'danger-full-access') {
      setSandboxMode(session, 'danger-full-access')
    }
    return
  }
  if (defaultMode === 'plan') {
    ;(session.append as (type: string, payload: { active: boolean }) => unknown)('plan/mode', { active: true })
  }
}
