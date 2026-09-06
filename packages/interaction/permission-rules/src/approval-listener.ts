/**
 * WS3 approval-seam listener: auto-approves sandbox escalations in `auto`
 * mode when the operation is attributable to the session workspace.
 *
 * WS0 verified that sandbox escalation prompts travel a separate
 * `approval/request` seam, independent of permission modes — so a mode-based
 * override cannot suppress them. This listener registers on that seam's
 * waterfall (before any UI listener) and resolves the request itself when
 * ALL of the following hold:
 *
 * 1. the request carries a reason identifying it as a sandbox escalation
 *    ({@link isSandboxEscalation});
 * 2. the effective permission mode for the requesting session is `auto`;
 * 3. the session has a resolvable workspace root (the per-call sandbox policy
 *    is derived from the session cwd — WS3 — so a known workspace root is
 *    exactly the boundary the escalation was evaluated against).
 *
 * Otherwise the request falls through to `next()` and the normal approval
 * flow proceeds. Every auto-approval is audit-logged to the session log as a
 * `permission/session-allow` record with `scope: 'sandbox-auto'`.
 *
 * @module @dsh-cc/permission-rules/approval-listener
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { appendSessionAllow } from './session-allowlist.ts'
import type { PermissionMode } from './types.ts'

/** Seams the listener reads off its configuring context; all injectable for tests. */
export interface SandboxApprovalListenerConfig {
  /** The effective permission mode for the requesting session. */
  modeOf(agent: Agent): PermissionMode
  /**
   * The session's workspace root, or undefined when none is known. An
   * undefined workspace root can never be auto-approved (the listener cannot
   * verify the operation is in scope) and falls through to the next provider.
   */
  workspaceOf(agent: Agent): string | undefined
}

/**
 * Whether an approval request's reason identifies a sandbox escalation.
 * Case-insensitive substring match on `sandbox` — the escalation reasons are
 * produced by the sandbox runtime and always name the mechanism.
 */
export function isSandboxEscalation(reason: string | undefined): boolean {
  return reason !== undefined && /sandbox/i.test(reason)
}

/**
 * Build the `approval/request` waterfall listener. Register the returned
 * listener ahead of the UI provider so an eligible sandbox escalation never
 * reaches the modal queue.
 */
export function createSandboxApprovalListener(config: SandboxApprovalListenerConfig): (
  req: ApprovalRequest,
  next: () => Promise<ApprovalOutcome>,
) => Promise<ApprovalOutcome> {
  return async (req, next) => {
    if (!isSandboxEscalation(req.reason)) return next()
    const agent = req.agent
    if (agent === undefined) return next()
    if (config.modeOf(agent) !== 'auto') return next()
    if (config.workspaceOf(agent) === undefined) return next()
    appendSessionAllow(agent.session, {
      scope: 'sandbox-auto',
      toolName: req.toolName,
      timestamp: Date.now(),
      ...req.reason === undefined ? {} : { reason: req.reason },
    })
    return 'allowed-once'
  }
}
