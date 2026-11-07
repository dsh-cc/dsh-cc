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
  // Harness 0.2.2: the `session/created` emit fires while the store's creation
  // announcement is still incomplete, and a synchronous append is rejected
  // ("cannot append before session/created completes"). Defer the pin one
  // microtask — the announcement completes synchronously after the listeners
  // return, so the pin lands before any subsequent macrotask observes it.
  queueMicrotask(() => pinNow(session, defaultMode, bypassDisabled, sandboxModeOf))
}

function pinNow(
  session: Session,
  defaultMode: PermissionMode,
  bypassDisabled: boolean,
  sandboxModeOf: () => SandboxMode | undefined,
): void {
  try {
    pinNowInner(session, defaultMode, bypassDisabled, sandboxModeOf)
  } catch {
    // A failed pin must never surface into the session store; the session
    // simply keeps the deployment default at runtime (non-durable).
  }
}

function pinNowInner(
  session: Session,
  defaultMode: PermissionMode,
  bypassDisabled: boolean,
  sandboxModeOf: () => SandboxMode | undefined,
): void {
  // A disposed session's append throws; the catch above contains it.
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
