/**
 * Ask-rejection guidance for unattended delegated sessions.
 * Extracted from pipeline.ts (file-size ratchet: pipeline.ts must not grow).
 * @module @dsh-cc/tools/ask-guidance
 */

/**
 * Guidance tail for a permission denial whose cause is environmental (no
 * approval answerer exists at all). One stable sentence.
 */
export const ASK_CHANNEL_GUIDANCE
  = 'This is an environment limitation, not a tool malfunction — do not retry this call in a loop.'

/**
 * Guidance tail for a USER-driven approval rejection: names the decision class
 * so a repeated rejection is not misread as a tool outage. One stable sentence.
 */
export const ASK_DENIAL_GUIDANCE
  = 'This is a permission decision, not a tool malfunction — do not retry the identical call unchanged; ask the user, explain why you need the action, or take a different approach.'

/** Stable prefix identifying the structured subagent ask rejection. */
export const SUBAGENT_ASK_PREFIX = 'no approval channel can answer this request in this delegated session'

/**
 * Model-facing hygiene for an embedded ask reason: the permission-rules lanes
 * sanitize their own strings, but third-party hook reasons arrive raw — strip
 * C0 controls/DEL, fold whitespace, cap at 120 chars (ellipsized).
 * @param reason - raw ask reason from any policy lane or hook.
 * @returns one single-line, bounded clause body.
 */
export function sanitizeAskReason(reason: string): string {
  const clean = reason.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.length <= 120 ? clean : `${clean.slice(0, 119)}…`
}

/** The parenthetical that carries the ask's reason into the denial text. */
export function askRaisedClause(ask: { reason?: string }): string {
  return ask.reason === undefined ? '' : ` (the ask was raised because: ${sanitizeAskReason(ask.reason)})`
}

/** Wire face of one log event that may or may not be an `approval/policy` record. */
interface ApprovalPolicyWire {
  readonly type?: unknown
  readonly data?: { readonly policy?: unknown } | undefined
}

/**
 * Last-wins fold of the session's `approval/policy` events.
 * @param events - session events in log order (other event types are skipped).
 * @returns true iff the CURRENT effective approval policy is `never` — the
 * deterministic rejection path the harness user-approval service resolves
 * before any answerer runs, so no human could have said no.
 */
export function approvalPolicyIsNever(events: readonly unknown[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as ApprovalPolicyWire | undefined
    // Tolerant wire read: an unparseable event is skipped, never thrown.
    if (event?.type !== 'approval/policy') continue
    return event.data?.policy === 'never'
  }
  return false
}

/** Wire face of the section of an agent the delegation predicates read. */
interface DelegatedSessionWire {
  readonly session?: {
    readonly header?: {
      readonly origin?: unknown
      readonly delegationDepth?: number | undefined
    } | undefined
  } | undefined
  readonly options?: { readonly subagentDepth?: number | undefined } | undefined
}

/**
 * Delegated-ancestry predicate, fail closed: a malformed agent SHAPE (one that
 * has a session but cannot be read) counts as a child (tool-use-summary
 * isTopLevel precedent, packages/compaction/tool-use-summary/src/index.ts:64-74).
 * An UNDEFINED agent is NOT delegated (the precedent treats an agent-less call
 * as top-level). Combines BOTH depth signals — header.delegationDepth and
 * agent.options.subagentDepth — plus header.origin === 'subagent'.
 * @param agent - live `Agent` (or an unreadable stand-in) for the call.
 * @returns whether the call runs inside a delegated (ancestor-subagent) session.
 */
export function isDelegatedSession(agent: unknown): boolean {
  if (agent === undefined) return false
  try {
    const shape = agent as DelegatedSessionWire
    if (shape.session === undefined) return false
    const header = shape.session.header
    // An unsafe/negative runtime depth is a child, mirroring the precedent.
    const runtimeDepth = shape.options?.subagentDepth
    if (runtimeDepth !== undefined && (!Number.isSafeInteger(runtimeDepth) || runtimeDepth < 0)) return true
    if (header?.origin === 'subagent') return true
    return Math.max(header?.delegationDepth ?? 0, runtimeDepth ?? 0) > 0
  } catch {
    return true
  }
}

/** Retry policy bucket for one ask trigger. */
export type AskTriggerCategory = 'underspecified' | 'transient' | 'structural'

/**
 * The reason constants the permission-rules lanes emit for a transient
 * classifier/gauge infrastructure failure. Matching is PREFIX-based on
 * purpose: the lanes append call detail to the reason (a probability tuple, a
 * rule citation), so the bare constant is never quoted from the message.
 */
const TRANSIENT_REASON_PREFIXES = [
  'state truncated by gateway',
  'gauge output unusable',
  'gauge allow probability missing or invalid',
  'unrecognized gauge choice',
] as const

/**
 * The one lane where a narrower command is a real move. The emitted literal is
 * `target/scope under-specified (underspec detector)`
 * (packages/interaction/permission-rules/src/gauge-stage.ts:258); only the
 * prefix is matched so the detector tag is not re-quoted here.
 */
const UNDERSPECIFIED_REASON_PREFIX = 'target/scope under-specified'

/** Exactly one category-scoped instruction per bucket. */
const CATEGORY_INSTRUCTION: Record<AskTriggerCategory, string> = {
  underspecified:
    'The trigger is an under-specified target or scope: you may retry ONCE with a materially narrower, explicitly scoped command; if this message appears again, stop.',
  transient:
    'The trigger is a transient classifier failure: you may retry the identical command ONCE; if this message appears again, stop.',
  structural:
    'Do not retry the call and do not work around the permission system; report this message and the exact command as a Blocker in your final report.',
}

/**
 * Trigger category for one ask reason (closed prefix table over the reason
 * constants the permission-rules lanes emit).
 * @param reason - the ask's reason, as raised by a policy lane or hook.
 * @returns `underspecified` (one narrowed retry), `transient` (one identical
 * retry) or `structural` — everything else, INCLUDING unknown/unmatched
 * reasons and rule-derived asks (fail closed against retry loops).
 */
export function classifyAskReason(reason: string | undefined): AskTriggerCategory {
  if (reason === undefined) return 'structural'
  const normalized = reason.trim()
  if (normalized.startsWith(UNDERSPECIFIED_REASON_PREFIX)) return 'underspecified'
  if (TRANSIENT_REASON_PREFIXES.some(prefix => normalized.startsWith(prefix))) return 'transient'
  return 'structural'
}

/**
 * Build the structured deny reason for one rejected ask of a delegated
 * session: the stable prefix, the sanitized original trigger, and exactly one
 * category-scoped instruction. Global text only — no executor-specific
 * workaround lists here (those live in the executor contract).
 * @param toolName - the rejected call's tool name (named only when the ask
 * carries no reason to quote).
 * @param reason - the ask's original trigger, sanitized into the clause.
 * @returns the whole model-facing deny reason (the pipeline prefixes `Error: `).
 */
export function subagentAskGuidance(toolName: string, reason: string | undefined): string {
  const trigger = reason === undefined
    ? `tool "${toolName}" was asked without a recorded reason`
    : `the ask was raised because: ${sanitizeAskReason(reason)}`
  return `${SUBAGENT_ASK_PREFIX} (${trigger}). ${CATEGORY_INSTRUCTION[classifyAskReason(reason)]}`
}
