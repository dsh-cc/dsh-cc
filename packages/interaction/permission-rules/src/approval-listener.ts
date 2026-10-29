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
 * Task-grant seam (design §3.5): when a grant for the session is live, this
 * baseline is REPLACED inside that task. A registered escalation (decide-side
 * registration for a grant-allowed call) is consumed and auto-approved only
 * after the grant's own checks; anything that misses the registry, or arrives
 * after the grant died, falls back to the USER — a grant relaxes the task and
 * tightens it. With no grant active, behavior is unchanged, and the baseline
 * re-validates grant ABSENCE at consume time so a grant created between the
 * approval check and its consumption cannot be bypassed.
 *
 * Otherwise the request falls through to `next()` and the normal approval
 * flow proceeds. Every auto-approval is audit-logged to the session log as a
 * `permission/session-allow` record with `scope: 'sandbox-auto'`.
 *
 * @module @dsh-cc/permission-rules/approval-listener
 */

import { currentToolExecution, type ToolExecution } from '@dsh-cc/tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { Session } from '@deepseek-ai/dsh-session'
import { appendSessionAllow } from './session-allowlist.ts'
import type { EscalationVerdict } from './grant-escalation.ts'
import type { PermissionMode } from './types.ts'

/** The task-grant face the listener consults (§3.5); absent without grants. */
export interface GrantEscalationFace {
  /** Whether any grant is live for the session (the consume-time re-validation). */
  anyActive(session: Session): boolean
  /** Consume one escalation request against the grant registry. */
  consume(input: {
    execution?: Readonly<ToolExecution>
    session: Session
    agentId: string
    toolName: string
    callId: string | undefined
    reason: string | undefined
  }): Promise<EscalationVerdict>
}

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
  /** The task-grant seam (§3.5), when the engine composes one. */
  grants?: GrantEscalationFace
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
 * Register the listener on the `approval/request` waterfall. Register it ahead
 * of the UI provider so an eligible sandbox escalation never reaches the modal
 * queue; every auto-approval is audit-logged to the session log
 * (`scope: 'sandbox-auto'`).
 * @param ctx - the context carrying the approval seam.
 * @param config - the mode/workspace/grant seams.
 */
export function registerApprovalListener(ctx: Context, config: SandboxApprovalListenerConfig): void {
  ctx.on('approval/request', createSandboxApprovalListener(config))
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
  const grants = config.grants
  return async (req, next) => {
    if (!isSandboxEscalation(req.reason)) return next()
    const agent = req.agent
    if (agent === undefined) return next()
    const session = agent.session
    if (grants !== undefined) {
      // §3.5: a registered grant escalation decides inside the task; a live
      // grant makes anything else a user decision.
      const hadActive = grants.anyActive(session)
      const execution = currentToolExecution()
      const verdict = await grants.consume({
        ...(execution === undefined ? {} : { execution }),
        session,
        agentId: String(agent.id),
        toolName: req.toolName,
        callId: req.callId === undefined ? undefined : String(req.callId),
        reason: req.reason,
      })
      if (verdict.kind === 'allowed-once') {
        appendSessionAllow(session, {
          scope: 'sandbox-auto',
          toolName: req.toolName,
          timestamp: Date.now(),
          ...req.reason === undefined ? {} : { reason: req.reason },
        })
        return 'allowed-once'
      }
      // Rule ① (TLA+ fold): the baseline re-validates grant ABSENCE at
      // consume time — with a grant live, a missed escalation is anomalous
      // and goes to the user. The revoked verdict already cleared its grant.
      if (verdict.kind === 'revoked' || (verdict.kind === 'fallback' && verdict.grantBound) || hadActive || grants.anyActive(session)) return next()
    }
    if (config.modeOf(agent) !== 'auto') return next()
    if (config.workspaceOf(agent) === undefined) return next()
    appendSessionAllow(session, {
      scope: 'sandbox-auto',
      toolName: req.toolName,
      timestamp: Date.now(),
      ...req.reason === undefined ? {} : { reason: req.reason },
    })
    return 'allowed-once'
  }
}
