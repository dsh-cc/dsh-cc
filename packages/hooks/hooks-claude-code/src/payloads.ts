/**
 * Per-event stdin payloads for the Claude Code hook dialect — the part the
 * bridge owns. Field names match CC's hook input schema. Split from index.ts
 * for the line budget; the only importer is the bridge's apply() (index.ts).
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
// Type-seam import: also pulls in the declaration-merged `events` interfaces so
// the `approval/*` (user-approval) payload fields below typecheck.
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import { ccCanonicalToolName, type ToolExecution, type ToolExecutionResult } from '@dsh-cc/tools'

/**
 * The `agent_type` value the bridge reports for SubagentStart/Stop. The harness
 * subagent seam carries no per-kind label, so the bridge uses Claude Code's own
 * Task-tool default — a hooks.json with a default/`*`/empty `agent_type` matcher
 * fires; a config matching a specific kind (e.g. `code-reviewer`) does not.
 * Also the matcher subject for those points (see index.ts).
 */
export const SUBAGENT_TYPE = 'general-purpose'

/** Flatten content blocks to the text a hook payload carries (the common case). */
function blocksToText(content: ContentBlock[]): string {
  return content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('')
}

function base(agent: Agent | undefined, event: string): Record<string, unknown> {
  return {
    session_id: agent?.session.header.id ?? '',
    // The pinned persistence seam exposes no public artifact-path accessor
    // (its jsonl backend's `locate` is private), so the field stays empty —
    // same as upstream's own hooks-claude-code at the pin, whose base() emits
    // `transcript_path: ''` (recorded consumer gap in that package's README).
    transcript_path: '',
    cwd: agent?.session.header.cwd ?? process.cwd(),
    hook_event_name: event,
  }
}

export function sessionStartPayload(_ctx: Context, agent: Agent, source: string): Record<string, unknown> {
  return { ...base(agent, 'SessionStart'), source }
}
/** SessionResume: the base session fields plus the `resume` source (CC's source enum). */
export function sessionResumePayload(_ctx: Context, agent: Agent, source: string): Record<string, unknown> {
  return { ...base(agent, 'SessionResume'), source }
}
export function promptPayload(_ctx: Context, agent: Agent, content: ContentBlock[]): Record<string, unknown> {
  return { ...base(agent, 'UserPromptSubmit'), prompt: blocksToText(content) }
}

/**
 * The CC canonical tool name for a hook payload. Claude Code hook scripts spell
 * tools with their CC names (`Read`, `Bash`, `Task`), so a canonical-name
 * payload is the CC-parity contract this bridge keeps: a harness `read`/`read_image`
 * surfaces as `Read`, `subagent_fork` as `Task`; a harness-only tool (e.g.
 * `ralph`) keeps its own name. See {@link ccCanonicalToolName}.
 */
function hookToolName(name: string): string {
  return ccCanonicalToolName(name)
}

export function preToolPayload(_ctx: Context, exec: ToolExecution): Record<string, unknown> {
  return { ...base(exec.agent, 'PreToolUse'), tool_name: hookToolName(exec.name), tool_input: exec.arguments, tool_use_id: exec.callId }
}
export function postToolPayload(_ctx: Context, exec: ToolExecution, result: ToolExecutionResult): Record<string, unknown> {
  return { ...base(exec.agent, 'PostToolUse'), tool_name: hookToolName(exec.name), tool_input: exec.arguments, tool_use_id: exec.callId, tool_response: blocksToText(result.content) }
}

/**
 * PostToolUseFailure: fired on an isError tool result. Mirror of PostToolUse
 * minus `tool_response`, carrying the error text flattened from the result
 * content (CC's `error` string). `is_interrupt` is omitted (not derivable from
 * the harness seam).
 */
export function postToolFailurePayload(_ctx: Context, exec: ToolExecution, result: ToolExecutionResult): Record<string, unknown> {
  return { ...base(exec.agent, 'PostToolUseFailure'), tool_name: hookToolName(exec.name), tool_input: exec.arguments, tool_use_id: exec.callId, error: blocksToText(result.content) }
}
/**
 * The Stop payload. `stopHookActive` is the CC `stop_hook_active` loop-guard
 * flag: `true` while the agent is already continuing BECAUSE of a Stop hook
 * (the bridge computes it from its consecutive-block counter before
 * incrementing — block #1 observes `false`). The SubagentStop payload keeps
 * `stop_hook_active: false` — the bridge never blocks at SubagentStop.
 */
export function stopPayload(_ctx: Context, agent: Agent, stopHookActive: boolean): Record<string, unknown> {
  return { ...base(agent, 'Stop'), stop_hook_active: stopHookActive }
}
/**
 * Build a SubagentStart/SubagentStop payload from the CC base (the child's
 * `session_id`/`cwd` when the child agent is available) plus the subagent-hook
 * fields. `agent_type` is the CC-default {@link SUBAGENT_TYPE}; `stop_hook_active`
 * is present on SubagentStop only (the loop-guard flag, always false).
 */
export function subagentPayload(_ctx: Context, event: 'SubagentStart' | 'SubagentStop', info: { id: string }, child: Agent | undefined): Record<string, unknown> {
  return {
    ...base(child, event),
    agent_id: info.id,
    agent_type: SUBAGENT_TYPE,
    ...event === 'SubagentStop' ? { stop_hook_active: false } : {},
  }
}

/**
 * Base payload for a hook event that has a session but no live agent handle
 * (session-event observers and `session/disposed`). Mirrors {@link base}, whose
 * `agent`-shaped fields come from the session header here.
 */
function sessionBase(session: Session, event: string): Record<string, unknown> {
  return {
    session_id: session.header.id,
    transcript_path: '',
    cwd: session.header.cwd ?? process.cwd(),
    hook_event_name: event,
  }
}

/** Setup (first-run approximation): a brand-new startup session fires with `source: 'init'`. */
export function setupPayload(_ctx: Context, agent: Agent): Record<string, unknown> {
  return { ...base(agent, 'Setup'), source: 'init' }
}

/** PermissionRequest: the tool the approval is about, from the tool-ext route. */
export function permissionRequestPayload(_ctx: Context, req: ApprovalRequest): Record<string, unknown> {
  return { ...base(req.agent, 'PermissionRequest'), tool_name: hookToolName(req.toolName) }
}

/** PermissionDenied: the observer only records the outcome, so the reason is approximated. */
export function permissionDeniedPayload(_ctx: Context, session: Session): Record<string, unknown> {
  return { ...sessionBase(session, 'PermissionDenied'), permission_denial_reason: 'Permission request rejected' }
}

/** Notification (permission_prompt subtype only): the question that was asked. */
export function notificationPayload(_ctx: Context, session: Session, asked: SessionEvent<'approval/asked'>): Record<string, unknown> {
  return {
    ...sessionBase(session, 'Notification'),
    notification_type: 'permission_prompt',
    tool_name: hookToolName(asked.data.toolName),
    ...asked.data.reason !== undefined ? { permission_denial_reason: asked.data.reason } : {},
  }
}

/** PostCompact: emitted after a compaction/end session event (observe-only). */
export function postCompactPayload(_ctx: Context, session: Session): Record<string, unknown> {
  return { ...sessionBase(session, 'PostCompact') }
}

/** SessionEnd: CC's `reason` is not derivable from `session/disposed`, so it is `'other'`. */
export function sessionEndPayload(_ctx: Context, session: Session): Record<string, unknown> {
  return { ...sessionBase(session, 'SessionEnd'), reason: 'other' }
}

/** Map a harness error onto Claude Code's StopFailure error-code vocabulary (default `unknown`). */
function stopFailureErrorCode(error: unknown): string {
  const raw = error && typeof error === 'object' && 'message' in error
    ? (error as { message: unknown }).message
    : error
  const message = String(raw).toLowerCase()
  if (message.includes('rate limit')) return 'rate_limit'
  if (message.includes('authentication') || message.includes('unauthorized') || message.includes('401') || message.includes('permission')) return 'authentication_failed'
  if (message.includes('billing') || message.includes('quota') || message.includes('credit')) return 'billing_error'
  if (message.includes('invalid request') || message.includes('bad request') || message.includes('400')) return 'invalid_request'
  if (message.includes('server error') || message.includes('overloaded') || message.includes('500')) return 'server_error'
  if (message.includes('max_output_tokens') || message.includes('output token')) return 'max_output_tokens'
  return 'unknown'
}

/** StopFailure: the failing agent plus the mapped error code and text. */
export function stopFailurePayload(_ctx: Context, agent: Agent, error: unknown): Record<string, unknown> {
  const message = error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error)
  return { ...base(agent, 'StopFailure'), error: message, error_code: stopFailureErrorCode(error) }
}

/** TaskCreated: the registry-issued id and producer label of a newly-appeared job. */
export function taskCreatedPayload(_ctx: Context, job: { id: JobId; label: string }): Record<string, unknown> {
  return { ...base(undefined, 'TaskCreated'), task_id: job.id, task_text: job.label }
}

/** TeammateIdle: a subagent entered idle (the bridge only fires for subagent scopes). */
export function teammateIdlePayload(_ctx: Context, agent: Agent): Record<string, unknown> {
  return { ...base(agent, 'TeammateIdle') }
}
