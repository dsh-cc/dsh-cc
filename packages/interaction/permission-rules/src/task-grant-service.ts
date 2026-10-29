/**
 * The task-grant collaborator of {@link PermissionRulesService} (design
 * §3.2–§3.6): store, matcher, escalation registry and the command-facing
 * create/list/revoke API. Extracted from index.ts for the file-size budget —
 * behavior is identical to the inline methods.
 *
 * @module @dsh-cc/permission-rules/task-grant-service
 */

import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@dsh-cc/tools'
import type { DecidedCall } from './decide.ts'
import type { GitRunner } from './grant-content-scope.ts'
import { GrantEscalations, type EscalationVerdict } from './grant-escalation.ts'
import { grantAdmitsExec, type GrantMatchContext } from './task-grant-match.ts'
import { deriveBranch, loadDescriptorFingerprint } from './task-grant-command.ts'
import {
  GrantValidationError,
  TaskGrantStore,
  appendTaskGrantEvent,
  buildTaskGrant,
  grantGoalExpired,
  normalizePath,
  type TaskGrant,
} from './task-grant.ts'
import { isBashToolName } from './matchers.ts'

/** The host facts the collaborator reads from the engine. */
export interface TaskGrantHostFace {
  bashToolName: string
  fileEditTools: ReadonlySet<string>
  /** The session workspace root (session-cwd fold, falling back to the header). */
  workspaceOf(agent: Agent): string | undefined
  /** The active goal id for a session, when a goal service is composed. */
  activeGoalIdOfSession(session: Session): string | null
}

/** Optional injectables (tests). */
export interface TaskGrantDeps {
  git?: GitRunner
}

/** One approved-but-unconfirmed view, keyed to the descriptor content shown. */
interface PendingGrant {
  readonly grant: TaskGrant
  /** sha256 of the exact descriptor bytes the user viewed. */
  readonly hash: string
  readonly facts: { root: string; branch: string | null; goalId: string | null }
}

/**
 * Session-scoped task grants (design §3.8: no cross-session persistence).
 * Every session reads its own log; a new session needs a fresh grant.
 */
export class TaskGrants {
  private readonly store = new TaskGrantStore()
  private readonly escalations: GrantEscalations
  /** View → confirm binding (P1b): keyed by session + descriptor path. */
  private readonly pending = new Map<string, PendingGrant>()

  constructor(private readonly host: TaskGrantHostFace, deps: TaskGrantDeps = {}) {
    this.escalations = new GrantEscalations({
      store: this.store,
      activeGoalId: (session) => this.host.activeGoalIdOfSession(session),
      ...deps.git === undefined ? {} : { git: deps.git },
    })
  }

  private static pendingKey(agent: Agent, descriptorPath: string): string {
    return `${String(agent.session.id)}\u0000${resolve(descriptorPath)}`
  }

  /** The live grants of one session (seeded from its log on first use). */
  of(agent: Agent): readonly TaskGrant[] {
    return this.store.of(String(agent.session.id), () => agent.session.snapshotEvents())
  }

  /**
   * Derive the complete post-derivation grant for the approval view (§3.3).
   * Nothing is persisted: the user must confirm first. The exact descriptor
   * content and host facts shown here are pinned for the confirm step.
   * @throws {GrantValidationError} when the descriptor or the host facts fail.
   */
  async propose(agent: Agent, descriptorPath: string): Promise<TaskGrant> {
    const { face, hash } = loadDescriptorFingerprint(descriptorPath)
    const facts = await this.hostFacts(agent)
    const grant = buildTaskGrant({ ...facts, face })
    this.pending.set(TaskGrants.pendingKey(agent, descriptorPath), { grant, hash, facts })
    return grant
  }

  /**
   * Create the grant after the user confirmed the rendered view (§3.3/P1b).
   * The confirmation binds to the exact descriptor CONTENT and host facts the
   * user saw: a descriptor rewritten (or a branch switched) between view and
   * confirm is rejected rather than silently creating a different grant.
   * @throws {GrantValidationError} when no view is pending or anything drifted.
   */
  async create(agent: Agent, descriptorPath: string): Promise<TaskGrant> {
    const key = TaskGrants.pendingKey(agent, descriptorPath)
    const pending = this.pending.get(key)
    if (pending === undefined) {
      throw new GrantValidationError(
        'no proposed grant is pending for this descriptor; run `/permissions grant <descriptorPath>` first',
      )
    }
    const { hash } = loadDescriptorFingerprint(descriptorPath)
    if (hash !== pending.hash) {
      throw new GrantValidationError(
        'the descriptor changed since the approval view; re-run `/permissions grant` to review the new content',
      )
    }
    const facts = await this.hostFacts(agent)
    if (facts.root !== pending.facts.root || facts.branch !== pending.facts.branch || facts.goalId !== pending.facts.goalId) {
      throw new GrantValidationError(
        'the workspace/branch/goal changed since the approval view; re-run `/permissions grant` to review the new context',
      )
    }
    this.pending.delete(key)
    const grant = pending.grant
    appendTaskGrantEvent(agent.session, { grant, timestamp: Date.now() })
    this.store.add(String(agent.session.id), () => agent.session.snapshotEvents(), grant)
    return grant
  }

  /**
   * Revoke one grant (§3.2: the clear record carries the grantId — never a
   * wipe-all) and drop its escalation registrations (rule ②, §3.5). The clear
   * record is appended BEFORE the in-memory store is mutated so a crash cannot
   * leave memory and the log divergent.
   * @returns whether the grant was live.
   */
  revoke(agent: Agent, grantId: string): boolean {
    const id = String(agent.session.id)
    const live = this.store.byId(id, () => agent.session.snapshotEvents(), grantId)
    if (live === undefined) return false
    appendTaskGrantEvent(agent.session, { cleared: grantId, reason: 'manual', timestamp: Date.now() })
    this.store.remove(id, () => agent.session.snapshotEvents(), grantId)
    this.escalations.clearGrant(grantId)
    return true
  }

  /** Session teardown: drop the session's grants, escalation entries and pending views. */
  disposeSession(session: Session): void {
    const id = String(session.id)
    this.escalations.clearSession(id)
    this.store.drop(id)
    for (const key of [...this.pending.keys()]) {
      if (key.startsWith(`${id}\u0000`)) this.pending.delete(key)
    }
  }

  /** The host-derived grant fields (§3.2): root realpath, branch, active goal. */
  private async hostFacts(agent: Agent): Promise<{ root: string; branch: string | null; goalId: string | null }> {
    const workspace = this.host.workspaceOf(agent)
    if (workspace === undefined) {
      throw new GrantValidationError('no session workspace root is known; a grant cannot be rooted')
    }
    const root = normalizePath(workspace)
    return { root, branch: await deriveBranch(root), goalId: this.host.activeGoalIdOfSession(agent.session) }
  }

  /**
   * The task-grant match (§3.4): a live grant that deterministically allows
   * this call, or undefined. Fixed order — a deny decision or non-LOW risk
   * never reaches the grant (a grant relaxes the LLM arbiter's ask, never a
   * deterministic verdict), and plan mode stays read-only. A grant whose
   * linked goal has completed is treated as expired here too (§3.2).
   */
  match(decided: DecidedCall, exec: ToolExecution): TaskGrant | undefined {
    if (decided.decision.kind === 'deny' || decided.risk.level !== 'LOW' || decided.mode === 'plan') return undefined
    const agent = exec.agent
    if (agent === undefined) return undefined
    const context: GrantMatchContext = {
      bashToolName: this.host.bashToolName,
      fileEditTools: this.host.fileEditTools,
    }
    const activeGoalId = this.host.activeGoalIdOfSession(agent.session)
    return this.of(agent).find(grant =>
      !grantGoalExpired(grant, activeGoalId) && grantAdmitsExec(grant, exec, context))
  }

  /** Register the escalation-seam entry for a grant-allowed bash call (§3.5). */
  registerEscalation(grant: TaskGrant, exec: ToolExecution): void {
    if (!grant.sandboxEscalation) return
    const agent = exec.agent
    if (agent === undefined) return
    if (!isBashToolName(exec.name, this.host.bashToolName)) return
    const command = (exec.arguments as Record<string, unknown>).command
    if (typeof command !== 'string') return
    this.escalations.register({
      session: agent.session,
      agentId: String(agent.id),
      toolName: exec.name,
      callId: String(exec.callId),
      command,
      grant,
    })
  }

  /** Post-hoc `git commit -a` contentScope verification (§3.6). */
  async takePostHoc(exec: ToolExecution, succeeded: boolean): Promise<string[]> {
    const agent = exec.agent
    if (agent === undefined) return []
    return this.escalations.takePostHoc(agent.session, succeeded)
  }

  /** Whether any grant is live for the session (§3.5 fallback tightening). */
  anyActive(session: Session): boolean {
    return this.escalations.anyActive(session)
  }

  /** Consume one sandbox escalation request against the grant registry. */
  consume(input: {
    session: Session
    agentId: string
    toolName: string
    callId: string | undefined
    reason: string | undefined
  }): Promise<EscalationVerdict> {
    return this.escalations.consume(input)
  }
}
