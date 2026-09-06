/**
 * Session-scoped approval memory (WS4-PR-B). A per-session allowlist of
 * permission rules the user granted through the "Allow for this session"
 * approval option. Rules live in an in-memory `SessionAllowlist` map keyed by
 * session id, and every grant (and clear) is also appended to the session log
 * as a `permission/session-allow` audit event carrying a timestamp — the
 * durable audit trail required by WS4. Session-scoped approvals never touch
 * the `permissions` settings namespace, so they do not persist across
 * sessions.
 *
 * Cross-repo event registration: this module adds `permission/session-allow`
 * to the upstream `KNOWN_SESSION_EVENT_TYPES` set at load (same pattern as
 * `permission/mode` in `./mode.ts`) so the persistence layer resumes logs
 * containing it.
 *
 * @module @dsh-cc/permission-rules/session-allowlist
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { parseRule } from './parser.ts'
import { ruleMatches, ruleMatchesTool } from './matchers.ts'
import type { PermissionRule } from './types.ts'

/** The session event type carrying a session-scoped approval audit record. */
export const SESSION_ALLOW_EVENT = 'permission/session-allow'

;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add(SESSION_ALLOW_EVENT)

/**
 * The `permission/session-allow` payload as written by this plugin. `scope`
 * distinguishes a user-granted session rule (`session`) from a sandbox
 * escalation auto-approved by the WS3 approval-seam listener (`sandbox-auto`,
 * which grants nothing — it only audits the auto-approval). `cleared` marks a
 * session-allowlist wipe and folds by emptying the accumulated set.
 */
export interface SessionAllowEventData {
  /** The permission rule granted, in `Bash(prefix )` / `Tool` string form. */
  rule?: string
  /** What produced the record. */
  scope: 'session' | 'sandbox-auto'
  /** The tool the record is about (audit context). */
  toolName: string
  /** Wall-clock time of the record (audit context). */
  timestamp: number
  /** The asker's reason string, when the approval carried one. */
  reason?: string
  /** Set on a clear record: everything before it is discarded by the fold. */
  cleared?: boolean
}

/** Wire face of one log event that may or may not be a `permission/session-allow`. */
interface SessionAllowWire {
  readonly type: string
  readonly data: SessionAllowEventData
}

/** Read a log event through the extended `permission/session-allow` face. */
function asAllowEvent(event: SessionEvent): SessionAllowWire {
  return event as unknown as SessionAllowWire
}

/**
 * Append one `permission/session-allow` audit record to the session log.
 * Goes through a widened append face (same cross-pin strategy as
 * `./mode.ts`): the event type postdates the upstream session catalog.
 */
export function appendSessionAllow(session: Session, data: SessionAllowEventData): void {
  type AppendFace = { append(type: string, data: SessionAllowEventData): unknown }
  ;(session as unknown as AppendFace).append(SESSION_ALLOW_EVENT, data)
}

/**
 * Fold a session log into the session-scoped allow rules it grants, in grant
 * order. A `cleared` record empties the accumulated set (last-wins semantics
 * for the clear). Sandbox-auto records carry no rule and contribute nothing.
 * @param events - session events in log order (other event types are skipped).
 * @returns the live session-scoped rules, source-labelled `session`.
 */
export function foldSessionAllows(events: readonly SessionEvent[]): PermissionRule[] {
  const raw: string[] = []
  for (const event of events) {
    const wire = asAllowEvent(event)
    if (wire.type !== SESSION_ALLOW_EVENT) continue
    if (wire.data?.cleared === true) {
      raw.length = 0
      continue
    }
    if (typeof wire.data?.rule === 'string' && wire.data.rule !== '') raw.push(wire.data.rule)
  }
  return raw.map(ruleRaw => parseRule(ruleRaw, 'allow', 'session'))
}

/**
 * The in-memory session-scoped allowlist: rules keyed by session id, checked
 * by `decide()` before the MEDIUM early-return. Purely in-memory — a restart
 * re-seeds from the session log's audit events (see {@link foldSessionAllows}),
 * and a different session id sees nothing.
 */
export class SessionAllowlist {
  private readonly bySession = new Map<string, PermissionRule[]>()

  /** Grant one rule to a session (appends the audit event as a side effect). */
  add(session: Session, rule: string): void {
    const id = String(session.id)
    const parsed = parseRule(rule, 'allow', 'session')
    const rules = this.bySession.get(id) ?? []
    if (!rules.some(existing =>
      existing.toolName === parsed.toolName
      && existing.content === parsed.content
      && existing.matcher === parsed.matcher
      && existing.behavior === parsed.behavior
    )) {
      rules.push(parsed)
      this.bySession.set(id, rules)
    }
    appendSessionAllow(session, {
      rule,
      scope: 'session',
      toolName: parsed.toolName,
      timestamp: Date.now(),
    })
  }

  /** Whether any session-scoped rule matches this call (tool name + subject). */
  matches(sessionId: string, toolName: string, subject: string | undefined): boolean {
    const rules = this.bySession.get(sessionId)
    if (rules === undefined) return false
    // `ruleMatches` is content-only (a whole-tool rule never matches it), so
    // whole-tool session grants match through `ruleMatchesTool` directly.
    return rules.some(rule =>
      rule.content === undefined
        ? ruleMatchesTool(rule, toolName)
        : subject !== undefined && ruleMatches(rule, toolName, subject),
    )
  }

  /** Drop every session-scoped rule for one session (appends a clear record). */
  clear(session: Session): void {
    const id = String(session.id)
    if (!this.bySession.has(id)) return
    this.bySession.delete(id)
    appendSessionAllow(session, {
      scope: 'session',
      toolName: '*',
      timestamp: Date.now(),
      cleared: true,
    })
  }

  /** Seed (or replace) one session's rules from its folded audit events. */
  seed(sessionId: string, rules: readonly PermissionRule[]): void {
    if (rules.length === 0) {
      this.bySession.delete(sessionId)
      return
    }
    this.bySession.set(sessionId, [...rules])
  }

  /** The parsed rules currently granted to one session (introspection). */
  rulesOf(sessionId: string): readonly PermissionRule[] {
    return this.bySession.get(sessionId) ?? []
  }
}
