/**
 * The session-scoped approval collaborator of {@link PermissionRulesService}:
 * the "Allow for this session" allowlist (WS4-PR-B) plus the session workspace
 * root read. Extracted from index.ts for the file-size budget — behavior is
 * identical to the inline methods.
 *
 * @module @dsh-cc/permission-rules/session-allow-service
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@dsh-cc/tools'
import { foldSessionCwd } from '@dsh-cc/session-cwd'
import { subjectOf } from './matchers.ts'
import { SessionAllowlist, foldSessionAllows } from './session-allowlist.ts'

/** Session-scoped allow rules and the session workspace root. */
export class SessionAllows {
  private readonly allowlist = new SessionAllowlist()
  /** Session ids already seeded from their log's audit events. */
  private readonly seeded = new Set<string>()

  constructor(private readonly bashToolName: string) {}

  /**
   * Whether the session-scoped allowlist matches this call. The session's
   * rules are seeded once from its log's `permission/session-allow` audit
   * events, so a resumed session keeps its grants. Agent-less calls never
   * match (there is no session to scope to).
   */
  matches(exec: ToolExecution): boolean {
    const agent = exec.agent
    if (agent === undefined) return false
    const id = String(agent.session.id)
    if (!this.seeded.has(id)) {
      this.seeded.add(id)
      this.allowlist.seed(id, foldSessionAllows(agent.session.snapshotEvents()))
    }
    return this.allowlist.matches(id, exec.name, subjectOf(exec, this.bashToolName))
  }

  /** Grant a session-scoped allow rule (in-memory match + audit event). */
  add(agent: Agent, rule: string): void {
    this.allowlist.add(agent.session, rule)
  }

  /** Drop every session-scoped rule for the agent's session (audited clear). */
  clear(agent: Agent): void {
    this.allowlist.clear(agent.session)
  }

  /**
   * The session's workspace root: the durable `worktree/entered` fold
   * (session-cwd, WS1), falling back to the session header cwd. Undefined
   * when the session never recorded a cwd — the sandbox listener then cannot
   * verify an escalation is in-scope and falls through to the normal ask.
   */
  workspaceOf(agent: Agent): string | undefined {
    return foldSessionCwd(agent.session.snapshotEvents()) ?? agent.session.header?.cwd
  }
}
