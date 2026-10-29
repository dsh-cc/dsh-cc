/**
 * The task-grant collaborator of {@link PermissionRulesService} (design
 * §3.2–§3.6): store, matcher, escalation registry and the command-facing
 * create/list/revoke API. Extracted from index.ts for the file-size budget —
 * behavior is identical to the inline methods.
 *
 * @module @dsh-cc/permission-rules/task-grant-service
 */

import { join, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { serializeGrantExecution, verifyGrantExecution } from './grant-execute.ts'
import type { ToolExecutionResult } from '@dsh-cc/tools'
import type { ToolExecution } from '@dsh-cc/tools'
import type { DecidedCall } from './decide.ts'
import { checkGrantContentScope, type GitRunner } from './grant-content-scope.ts'
import { isVwaStateWrite } from './vwa-state.ts'
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
  isPathWithin,
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
  private readonly authorized = new Map<symbol, { grant: TaskGrant; decided: DecidedCall }>()
  private readonly store = new TaskGrantStore()
  private readonly escalations: GrantEscalations
  /** View → confirm binding (P1b): keyed by session + descriptor path. */
  private readonly pending = new Map<string, PendingGrant>()

  constructor(private readonly host: TaskGrantHostFace, deps: TaskGrantDeps = {}) {
    this.escalations = new GrantEscalations({
      store: this.store,
      validateContext: async (grant, exec) => {
        if (exec.agent === undefined) return false
        const workspace = this.host.workspaceOf(exec.agent)
        const args = exec.arguments as Record<string, unknown>
        if (workspace === undefined || normalizePath(workspace) !== grant.root
          || (typeof args.workdir === 'string' && normalizePath(resolve(grant.root, args.workdir)) !== grant.root)) return false
        return await deriveBranch(grant.root) === grant.branch
      },
      activeGoalId: (session) => this.host.activeGoalIdOfSession(session),
      ...deps.git === undefined ? {} : { git: deps.git },
    })
  }

  private pendingKey(agent: Agent, descriptorPath: string): string {
    return `${String(agent.session.id)}\u0000${normalizePath(resolve(this.host.workspaceOf(agent) ?? '', descriptorPath))}`
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
    const { face, hash } = loadDescriptorFingerprint(normalizePath(resolve(this.host.workspaceOf(agent) ?? '', descriptorPath)))
    const facts = await this.hostFacts(agent)
    for (const path of face.writePaths) {
      const target = normalizePath(join(facts.root, path))
      if (!isPathWithin(facts.root, target)) throw new GrantValidationError('writePath escapes workspace root')
      if (isVwaStateWrite(target, facts.root) || isPathWithin(target, normalizePath(join(facts.root, '.dsh/vwa')))) throw new GrantValidationError('writePath covers authoritative VWA state')
    }
    const grant = buildTaskGrant({ ...facts, face })
    this.pending.set(this.pendingKey(agent, descriptorPath), { grant, hash, facts })
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
    const key = this.pendingKey(agent, descriptorPath)
    const pending = this.pending.get(key)
    if (pending === undefined) {
      throw new GrantValidationError(
        'no proposed grant is pending for this descriptor; run `/permissions grant <descriptorPath>` first',
      )
    }
    const { hash } = loadDescriptorFingerprint(normalizePath(resolve(this.host.workspaceOf(agent) ?? '', descriptorPath)))
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
    const workspace = this.host.workspaceOf(agent)
    return this.of(agent).find(grant =>
      workspace !== undefined && normalizePath(workspace) === grant.root && !grantGoalExpired(grant, activeGoalId) && grantAdmitsExec(grant, exec, context))
  }

  /** Validate actual execution facts before any grant relaxation, including unsandboxed calls. */
  async authorize(decided: DecidedCall, exec: ToolExecution): Promise<TaskGrant | undefined> {
    const grant = this.match(decided, exec)
    if (grant === undefined) return undefined
    if (!isBashToolName(exec.name, this.host.bashToolName)) return grant
    const args = exec.arguments as Record<string, unknown>
    const workdir = typeof args.workdir === 'string' ? normalizePath(resolve(grant.root, args.workdir)) : grant.root
    if (workdir !== grant.root) throw new GrantValidationError('Task grant does not authorize this working directory')
    const branch = await deriveBranch(grant.root)
    if (branch !== grant.branch) throw new GrantValidationError('Task grant branch changed')
    const command = String(args.command)
    if (grant.contentScope === 'tracked-md-only' && args.run_in_background === true) throw new GrantValidationError('Scoped background calls require human approval')
    const violations = await checkGrantContentScope(grant, command)
    if (violations.length > 0) {
      this.revoke(exec.agent!, grant.grantId)
      throw new GrantValidationError(violations.join('; '))
    }
    if (this.match(decided, exec) !== grant) throw new GrantValidationError('Task grant changed during verification')
    if (await deriveBranch(grant.root) !== branch || this.match(decided, exec) !== grant) throw new GrantValidationError('Task grant context changed during verification')
    this.authorized.set(exec.token, { grant, decided })
    return grant
  }

  async execute(exec: ToolExecution, next: () => Promise<ToolExecutionResult>, waitBackground?: (id: string) => Promise<void>): Promise<ToolExecutionResult> {
    const workspace = exec.agent === undefined ? undefined : this.host.workspaceOf(exec.agent)
    if (workspace === undefined || !isBashToolName(exec.name, this.host.bashToolName)) return next()
    return serializeGrantExecution(normalizePath(workspace), async () => {
      const admitted = this.authorized.get(exec.token)
      if (admitted === undefined) return next()
      const live = await this.authorize(admitted.decided, exec)
      if (live !== admitted.grant) throw new GrantValidationError('Task grant changed before execution')
      return verifyGrantExecution(live, exec, next, () => { this.revoke(exec.agent!, live.grantId) }, waitBackground)
    })
  }

  clearExecution(exec: ToolExecution): void { this.authorized.delete(exec.token); this.escalations.clearExecution(exec.token) }

  /** Register the escalation-seam entry for a grant-allowed bash call (§3.5). */
  registerEscalation(grant: TaskGrant, exec: ToolExecution): void {
    if (!grant.sandboxEscalation) return
    const agent = exec.agent
    if (agent === undefined) return
    if (!isBashToolName(exec.name, this.host.bashToolName)) return
    const command = (exec.arguments as Record<string, unknown>).command
    if (typeof command !== 'string') return
    this.escalations.register({
      executionToken: exec.token,
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
    execution?: Readonly<ToolExecution>
    session: Session
    agentId: string
    toolName: string
    callId: string | undefined
    reason: string | undefined
  }): Promise<EscalationVerdict> {
    return this.escalations.consume(input)
  }
}
