/**
 * Consumption point 2 — sandbox escalation under a task grant (design §3.5).
 *
 * The decide side registers one escalation entry per grant-allowed bash call,
 * bound to the call's execution identity and the command hash. The approval
 * listener later consumes that entry (one shot) and auto-answers
 * `allowed-once` only when EVERY check passes: reason shape, mode ceiling,
 * grant still live, branch guard, contentScope. Anything else falls back to
 * the user — fail closed.
 *
 * DEVIATION (noted, design §3.5 cites a bare callId): this harness's approval
 * seam ({@link ApprovalRequest}) carries no execution token AND NO COMMAND TEXT
 * — the runtime token is a process-private Symbol (runtime-execute.ts) and
 * never reaches `approval/request`. The registry therefore binds on
 * `(sessionId, callId)`, and the property that makes that safe is the runtime's
 * one-callId-per-execution guarantee: the entry consumed at approval time is
 * the entry the decide side registered for THAT execution. `commandHash` is
 * recorded as a corroborating fingerprint and checked at registration (a live
 * entry with the same callId but a different hash means callId reuse — the
 * entry is dropped and the escalation falls back to the user). It cannot be
 * compared at consume time because the request carries no command text.
 *
 * @module @dsh-cc/permission-rules/grant-escalation
 */

import { createHash } from 'node:crypto'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import {
  commitPostHocViolations,
  commitScopeViolations,
  isCommitCommand,
  isPushCommand,
  pushScopeViolations,
  spawnGit,
  stagesAtCommit,
  type GitRunner,
} from './grant-content-scope.ts'
import {
  appendTaskGrantEvent,
  grantGoalExpired,
  type TaskGrant,
  type TaskGrantStore,
} from './task-grant.ts'

/** The escalation reason prefix the sandbox runtime emits (escalation.ts:192). */
const ESCALATION_REASON = /^escalate sandbox to (read-only|workspace-write|danger-full-access): /

/** Sandbox mode widening ranks (higher = wider). */
const MODE_RANK: Record<SandboxMode, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
}

/** Normalize command text for hashing: trim, collapse whitespace runs. */
export function normalizeCommandText(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

/** `sha256` of the normalized command text (§3.5). */
export function commandHash(command: string): string {
  return createHash('sha256').update(normalizeCommandText(command)).digest('hex')
}

/**
 * Parse the requested escalation mode out of an approval reason. Any other
 * reason shape returns undefined and the caller falls back to the user
 * (fail closed for unknown reason variants).
 * @param reason - the approval request's reason text.
 * @returns the requested mode, or undefined.
 */
export function parseEscalationMode(reason: string | undefined): SandboxMode | undefined {
  if (reason === undefined) return undefined
  const match = ESCALATION_REASON.exec(reason)
  return match === null ? undefined : (match[1] as SandboxMode)
}

/** Whether a requested mode is at or under a grant's ceiling. */
export function withinModeCeiling(ceiling: SandboxMode, requested: SandboxMode): boolean {
  return MODE_RANK[requested] <= MODE_RANK[ceiling]
}

/** One registry entry: the execution identity a grant-allowed call registered. */
export interface EscalationEntry {
  readonly sessionId: string
  readonly agentId: string
  readonly toolName: string
  readonly callId: string
  /** `sha256` of the normalized command text. */
  readonly commandHash: string
  /** The command text (contentScope judgment needs it at consume time). */
  readonly command: string
  readonly grantId: string
  readonly modeCeiling: SandboxMode
  readonly ts: number
}

/** A terminal post-hoc verification queued by an auto-approved `git commit -a`. */
interface PostHocCheck {
  readonly grantId: string
  readonly root: string
}

/**
 * The one-shot escalation registry. Keyed by `(sessionId, callId)`; a
 * registration is deleted when consumed (every terminal path), and every
 * registration of a grant dies with it (revoke/expiry/reset — rule ② of the
 * TLA+ fold, §3.5).
 */
export class EscalationRegistry {
  private readonly entries = new Map<string, EscalationEntry>()

  private static key(sessionId: string, callId: string): string {
    return `${sessionId}\u0000${callId}`
  }

  /**
   * Register the entry for one call. A live entry with the same callId but a
   * DIFFERENT commandHash is callId reuse: both are dropped and the call falls
   * back to the user (fail closed).
   * @returns whether the entry was registered.
   */
  register(entry: EscalationEntry): boolean {
    const key = EscalationRegistry.key(entry.sessionId, entry.callId)
    const existing = this.entries.get(key)
    if (existing !== undefined && existing.commandHash !== entry.commandHash) {
      this.entries.delete(key)
      return false
    }
    this.entries.set(key, entry)
    return true
  }

  /** Peek without consuming (introspection/tests). */
  peek(sessionId: string, callId: string): EscalationEntry | undefined {
    return this.entries.get(EscalationRegistry.key(sessionId, callId))
  }

  /** Consume: take the entry and delete it in one step. */
  consume(sessionId: string, callId: string): EscalationEntry | undefined {
    const key = EscalationRegistry.key(sessionId, callId)
    const entry = this.entries.get(key)
    this.entries.delete(key)
    return entry
  }

  /** Drop every entry registered by one grant. */
  clearGrant(grantId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.grantId === grantId) this.entries.delete(key)
    }
  }

  /** Drop every entry of one session (session reset / end). */
  clearSession(sessionId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.sessionId === sessionId) this.entries.delete(key)
    }
  }

  /** The live entry count (introspection/tests). */
  get size(): number {
    return this.entries.size
  }
}

/** The verdict of consuming one escalation. */
export type EscalationVerdict =
  /** Registry hit and every check passed: answer `allowed-once`. */
  | { kind: 'allowed-once'; grantId: string; mode: SandboxMode }
  /** Missed the registry or failed a check: fall back (the listener decides user vs baseline). */
  | { kind: 'fallback'; why: string }
  /** A pre-check violation revoked the grant as well. */
  | { kind: 'revoked'; grantId: string; why: string }

/** Dependency face of the escalation controller. */
export interface GrantEscalationDeps {
  readonly store: TaskGrantStore
  /** Direct git runner (never the shell service). */
  readonly git?: GitRunner
  /** Host clock (tests). */
  readonly now?: () => number
  /** The session's active goal id (§3.2 goal-complete); absent ⇒ any goal link is stale. */
  readonly activeGoalId?: (session: Session) => string | null
}

/**
 * The decide-side registration + approval-side consumption of grant
 * escalations. Sessions own their registry; stores are session-scoped.
 */
export class GrantEscalations {
  private readonly registry = new EscalationRegistry()
  private readonly postHoc = new Map<string, PostHocCheck[]>()

  constructor(private readonly deps: GrantEscalationDeps) {}

  private git(): GitRunner {
    return this.deps.git ?? spawnGit
  }

  /** The live grants of one session (seeding from its log on first use). */
  grantsOf(session: Session): readonly TaskGrant[] {
    return this.deps.store.of(String(session.id), () => session.snapshotEvents())
  }

  /** Whether any grant is live for the session (§3.5 fallback tightening). */
  anyActive(session: Session): boolean {
    return this.grantsOf(session).length > 0
  }

  /**
   * Register the escalation entry for one grant-allowed bash call.
   * @param input - the call identity and the admitting grant.
   */
  register(input: { session: Session; agentId: string; toolName: string; callId: string; command: string; grant: TaskGrant }): void {
    this.registry.register({
      sessionId: String(input.session.id),
      agentId: input.agentId,
      toolName: input.toolName,
      callId: input.callId,
      commandHash: commandHash(input.command),
      command: input.command,
      grantId: input.grant.grantId,
      modeCeiling: input.grant.modeCeiling,
      ts: (this.deps.now ?? Date.now)(),
    })
  }

  /** Drop every registration of one grant (revoke/expiry/reset). */
  clearGrant(grantId: string): void {
    this.registry.clearGrant(grantId)
  }

  /** Drop every registration/queued check of one session (session teardown). */
  clearSession(sessionId: string): void {
    this.registry.clearSession(sessionId)
    this.postHoc.delete(sessionId)
  }

  /**
   * Consume one sandbox escalation request.
   * @param input - the request's execution identity and reason.
   * @returns the verdict (always after the entry is consumed).
   */
  async consume(input: {
    session: Session
    agentId: string
    toolName: string
    callId: string | undefined
    reason: string | undefined
  }): Promise<EscalationVerdict> {
    if (input.callId === undefined) return { kind: 'fallback', why: 'no call id on the approval request' }
    const entry = this.registry.consume(String(input.session.id), input.callId)
    if (entry === undefined) return { kind: 'fallback', why: 'no registered grant escalation for this call' }
    const requested = parseEscalationMode(input.reason)
    if (requested === undefined) return { kind: 'fallback', why: 'unrecognized escalation reason shape' }
    if (!withinModeCeiling(entry.modeCeiling, requested)) {
      return { kind: 'fallback', why: `requested mode ${requested} exceeds the grant ceiling ${entry.modeCeiling}` }
    }
    const grant = this.deps.store.byId(String(input.session.id), () => input.session.snapshotEvents(), entry.grantId)
    if (grant === undefined) return { kind: 'fallback', why: 'the admitting grant is no longer active' }
    if (grantGoalExpired(grant, this.deps.activeGoalId?.(input.session) ?? null)) {
      return { kind: 'fallback', why: 'the grant\'s goal has completed' }
    }
    // Branch guard: a DIRECT git spawn (a shell round-trip would re-enter approvals).
    let branch: string
    try {
      branch = (await this.git()(grant.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    } catch {
      return { kind: 'fallback', why: 'branch guard could not resolve the current branch' }
    }
    if (branch !== grant.branch) return { kind: 'fallback', why: `branch drifted from ${String(grant.branch)} to ${branch}` }
    if (grant.contentScope === 'tracked-md-only') {
      const violations = await this.scopeViolations(grant, entry.command)
      if (violations.length > 0) return this.revoke(grant, input.session, violations.join('; '))
    }
    if (grant.contentScope === 'tracked-md-only' && stagesAtCommit(entry.command)) {
      const pending = this.postHoc.get(String(input.session.id)) ?? []
      pending.push({ grantId: grant.grantId, root: grant.root })
      this.postHoc.set(String(input.session.id), pending)
    }
    return { kind: 'allowed-once', grantId: grant.grantId, mode: requested }
  }

  /** The contentScope pre-checks for one grant-allowed command. */
  private async scopeViolations(grant: TaskGrant, command: string): Promise<string[]> {
    try {
      if (isPushCommand(command)) {
        if (grant.branch === null) return ['push under a grant with no branch']
        return await pushScopeViolations(grant.root, grant.branch, this.git())
      }
      if (isCommitCommand(command)) return await commitScopeViolations(grant.root, this.git())
    } catch (error: unknown) {
      // A failed check is not a pass: fail closed to the user.
      return [`content-scope check failed: ${String(error)}`]
    }
    return []
  }

  /** Revoke a grant for a contentScope violation and report it. */
  private revoke(grant: TaskGrant, session: Session, why: string): EscalationVerdict {
    appendTaskGrantEvent(session, {
      cleared: grant.grantId,
      reason: 'content-scope-violation',
      timestamp: (this.deps.now ?? Date.now)(),
    })
    this.deps.store.remove(String(session.id), () => session.snapshotEvents(), grant.grantId)
    this.clearGrant(grant.grantId)
    return { kind: 'revoked', grantId: grant.grantId, why }
  }

  /**
   * Run the queued post-hoc `git commit -a` verifications for one session and
   * revoke on violation (§3.6: the commit has happened and cannot be rolled
   * back — the residual is declared, the grant dies and the page stops).
   * @param session - the committing session.
   * @param succeeded - whether the tool call succeeded (a failed commit is not verified).
   * @returns violation reports, empty when in scope.
   */
  async takePostHoc(session: Session, succeeded: boolean): Promise<string[]> {
    const id = String(session.id)
    const pending = this.postHoc.get(id)
    if (pending === undefined || pending.length === 0) return []
    this.postHoc.delete(id)
    if (!succeeded) return []
    const reports: string[] = []
    for (const check of pending) {
      let violations: string[]
      try {
        violations = await commitPostHocViolations(check.root, this.git())
      } catch (error: unknown) {
        violations = [`post-hoc content-scope check failed: ${String(error)}`]
      }
      if (violations.length === 0) continue
      const grant = this.deps.store.byId(id, () => session.snapshotEvents(), check.grantId)
      if (grant !== undefined) this.revoke(grant, session, violations.join('; '))
      reports.push(violations.join('; '))
    }
    return reports
  }
}
