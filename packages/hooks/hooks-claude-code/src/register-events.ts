/**
 * Event-listener registration for the hooks-claude-code bridge, extracted
 * from {@link ./index!apply | apply} so the entry stays under the 500-line
 * source budget. Every listener below was previously inline in `apply()`.
 * @module @dsh-cc/hooks-claude-code/register-events
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import type { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import type { PostToolDecision, PreToolDecision, ToolExecution } from '@dsh-cc/tools'
import type { DetachedRuns } from '@dsh-cc/hook-protocol'
import {
  notificationPayload,
  permissionDeniedPayload,
  permissionRequestPayload,
  postCompactPayload,
  postToolFailurePayload,
  postToolPayload,
  preToolPayload,
  promptPayload,
  sessionEndPayload,
  stopFailurePayload,
  stopPayload,
  subagentPayload,
  SUBAGENT_TYPE,
  taskCreatedPayload,
  teammateIdlePayload,
} from './payloads.ts'
import { createRunPoint } from './run-point.ts'
import { lastTurn, type TurnSafety } from './turn-safety.ts'

/** The run-point function shape (return type of {@link createRunPoint}). */
type RunPoint = ReturnType<typeof createRunPoint>

/** Shared mutable state the listeners close over, bundled for the extractor. */
export interface ListenerDeps {
  readonly ctx: Context
  readonly detached: DetachedRuns
  readonly runPoint: RunPoint
  readonly turnSafety: TurnSafety
  /** Retained subagent children keyed by run id, for stop hooks. */
  readonly subagentChildren: Map<SubagentRunId, Agent>
  /** Every subagent id seen via start/end, for the TeammateIdle filter. */
  readonly subagentIds: Set<string>
}

/**
 * Register every bridge event listener. Called once from `apply()` after the
 * config is parsed and the run point / turn-safety cluster are built.
 */
export function registerEvents(deps: ListenerDeps): void {
  const { ctx, detached, runPoint, turnSafety, subagentChildren, subagentIds } = deps

  // --- UserPromptSubmit → PreStepDecision. The prompt text is the payload; no
  // matcher subject (CC ignores matchers for this event). ---
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
    if (messages.length === 0) return next()
    // F1: a REAL user turn breaks the stop-block chain (plugin-source steering
    // and notices must not reset it — they all use `{kind:'plugin'}` sources).
    if (messages.some(message => message.source.kind === 'user')) turnSafety.resetBlocks(agent.id)
    const content = messages.flatMap(message => message.content)
    const merged = await runPoint('UserPromptSubmit', '', promptPayload(ctx, agent, content), { agent, turn, signal })
    const halted = turnSafety.applyHalt('UserPromptSubmit', merged, agent)
    turnSafety.surfaceNotices('UserPromptSubmit', merged, agent)
    if (halted || merged.decision === 'deny') {
      return { kind: 'reject' }
    }
    // Delegate so later listeners may still rewrite or reject, then prepend our
    // context only to a downstream enter decision.
    const downstream = await next()
    const ours = turnSafety.contextFrom(merged)
    if (!ours || downstream.kind !== 'enter') return downstream
    return {
      kind: 'enter',
      messages: [...downstream.messages, ours],
    }
  })

  // --- PreToolUse → PreToolDecision. Matcher subject is the tool name. ---
  // Registered with `{ prepend: true }` (F4, session-cwd precedent) so the hook
  // decision is consulted ahead of permission-rules regardless of compose order.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const turn = lastTurn(exec.agent)
    // `exec` is typed in both worlds (the in-box registry's interface merge and
    // the vendored one share the event name); at runtime the vendored registry
    // is the only `tools` service, so the value is always ours. See package README.
    const ccExec = exec as ToolExecution
    const merged = await runPoint('PreToolUse', ccExec.name, preToolPayload(ctx, ccExec), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    const halted = turnSafety.applyHalt('PreToolUse', merged, exec.agent)
    turnSafety.surfaceNotices('PreToolUse', merged, exec.agent)
    if (halted) return { kind: 'deny', reason: merged.stopReason ?? 'halted by PreToolUse hook' }
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' }
    // S1: a non-deny `additionalContext` is injected for the next model request
    // (documented ordering divergence: CC attaches it to the tool call itself;
    // here it lands in the loop's post-result FIFO).
    const context = turnSafety.contextFrom(merged)
    if (context && exec.agent) exec.agent.inject(context)
    // F4: delegate FIRST so a downstream boundary deny still beats a hook
    // ask/allow (stricter than the hook); only then apply the hook decision —
    // `allow` suppresses the permission prompt entirely.
    const downstream = await next()
    if (downstream.kind === 'deny') return downstream
    if (merged.decision === 'ask') return { kind: 'ask', ...merged.reason !== undefined ? { reason: merged.reason } : {} }
    if (merged.decision === 'allow') return { kind: 'allow' }
    return downstream
  }, { prepend: true })

  // --- PostToolUse → PostToolDecision. Matcher subject is the tool name. ---
  // PostToolUseFailure rides the same seam as an observe-only emit when the
  // tool result is an error (`result.isError`), matching CC where the two are
  // mutually exclusive on a single tool call. Matcher subject is also the tool
  // name.
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    // Same boundary cast as the PreToolUse listener above.
    const ccExec = exec as ToolExecution
    const turn = lastTurn(exec.agent)
    if (result.isError) {
      detached.track(runPoint('PostToolUseFailure', ccExec.name, postToolFailurePayload(ctx, ccExec, result), { ...exec.agent ? { agent: exec.agent } : {}, signal: exec.signal ?? detached.signal })
        .then((merged) => { turnSafety.detachedOutcome('PostToolUseFailure', merged, exec.agent) })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: PostToolUseFailure hook failed: ${String(error)}`) }))
    }
    const merged = await runPoint('PostToolUse', ccExec.name, postToolPayload(ctx, ccExec, result), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    const halted = turnSafety.applyHalt('PostToolUse', merged, exec.agent)
    turnSafety.surfaceNotices('PostToolUse', merged, exec.agent)
    if (halted) {
      return { kind: 'block', feedback: [{ type: 'text', text: merged.stopReason ?? 'halted by PostToolUse hook' }] }
    }
    const context = turnSafety.contextFrom(merged)
    if (merged.decision === 'deny') {
      return { kind: 'block', feedback: [{ type: 'text', text: merged.reason ?? 'blocked by PostToolUse hook' }], ...context ? { additionalContexts: [context] } : {} }
    }
    // Our hooks did not block. DELEGATE so a later listener can still block/replace,
    // then fold our context onto its decision (a downstream block carries it too).
    const downstream = await next()
    // S2: a hook tool-RESULT replacement applies only when the downstream fold
    // is a PLAIN accept with no content/value of its own — a downstream block
    // beats replacement (downstream/boundaries win). The MCP variant applies
    // only to `mcp__*` tools; the mismatched field is ignored (debug log).
    let replacement: { type: 'text'; text: string } | undefined
    if (downstream.kind === 'accept' && downstream.content === undefined && downstream.value === undefined) {
      const isMcp = ccExec.name.startsWith('mcp__')
      const raw = isMcp ? merged.updatedMCPToolOutput : merged.updatedToolOutput
      const ignored = isMcp ? merged.updatedToolOutput : merged.updatedMCPToolOutput
      if (ignored !== undefined) {
        ctx.logger.debug(`hooks-claude-code: PostToolUse hook sent the ${isMcp ? 'updatedToolOutput' : 'updatedMCPToolOutput'} field for ${isMcp ? '' : 'non-'}MCP tool ${ccExec.name} — ignored`)
      }
      if (raw !== undefined) {
        replacement = { type: 'text', text: typeof raw === 'string' ? raw : JSON.stringify(raw) }
      }
    }
    if (!context && replacement === undefined) return downstream
    if (downstream.kind === 'block') {
      // A downstream block beats replacement; it carries the context when present.
      return context === undefined
        ? downstream
        : { ...downstream, additionalContexts: turnSafety.prependContext(context, downstream.additionalContexts) }
    }
    if (replacement !== undefined) {
      return {
        kind: 'accept',
        content: [replacement],
        ...context ? { additionalContexts: turnSafety.prependContext(context, downstream.additionalContexts) } : {},
      }
    }
    if (context === undefined) return downstream
    return {
      ...downstream,
      additionalContexts: turnSafety.prependContext(context, downstream.additionalContexts),
    }
  })

  // A blocking Stop hook steers at the stopping boundary, which makes the
  // machine observe pending input and run another step. F1 caps the loop: the
  // payload's `stop_hook_active` is computed BEFORE incrementing (block #1
  // observes false), and after `cap` consecutive blocks the hook is overridden.
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    const merged = await runPoint('Stop', '', stopPayload(ctx, agent, turnSafety.hasBlocks(agent.id)), { agent, turn, signal })
    if (turnSafety.applyHalt('Stop', merged, agent)) {
      turnSafety.surfaceNotices('Stop', merged, agent)
      return
    }
    if (merged.decision === 'deny') {
      turnSafety.onStopDeny(agent, merged)
    }
    turnSafety.surfaceNotices('Stop', merged, agent)
  })

  // SubagentStart may inject child context; SubagentStop only observes. Both
  // use the live child's workspace and the generic agent-type matcher subject.
  ctx.on('subagent/start', (info) => {
    const child = ctx.get('agents')?.get(info.id)
    subagentIds.add(info.id)
    if (child !== undefined) subagentChildren.set(info.runId, child)
    detached.track(runPoint('SubagentStart', SUBAGENT_TYPE, subagentPayload(ctx, 'SubagentStart', info, child), { ...child ? { agent: child } : {}, signal: detached.signal })
      .then((merged) => {
        turnSafety.detachedOutcome('SubagentStart', merged, child)
        const context = turnSafety.contextFrom(merged)
        if (context && child) child.inject(context)
      })
      .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: SubagentStart hook failed: ${String(error)}`) }))
  })
  ctx.on('subagent/end', (info) => {
    const child = subagentChildren.get(info.runId) ?? ctx.get('agents')?.get(info.id)
    subagentChildren.delete(info.runId)
    subagentIds.add(info.id)
    detached.track(runPoint('SubagentStop', SUBAGENT_TYPE, subagentPayload(ctx, 'SubagentStop', info, child), { ...child ? { agent: child } : {}, signal: detached.signal })
      .then((merged) => { turnSafety.detachedOutcome('SubagentStop', merged, child) }))
  })

  // --- The expanded observe/interception event set (see README for the full
  // supported/unsupported enumeration against Claude Code's hook events). ---

  // PermissionRequest → interception on the approval waterfall. `deny` rejects the
  // request; `allow`/`approve` pre-approves it; otherwise the downstream answerer
  // chain decides (`ask`/no-decision delegate to `next()`). F2: a `continue:false`
  // hook rejects and cancels.
  ctx.on('approval/request', async (req: ApprovalRequest, next): Promise<ApprovalOutcome> => {
    const merged = await runPoint('PermissionRequest', '', permissionRequestPayload(ctx, req), { ...req.agent ? { agent: req.agent } : {}, signal: req.signal ?? detached.signal })
    const halted = turnSafety.applyHalt('PermissionRequest', merged, req.agent)
    turnSafety.surfaceNotices('PermissionRequest', merged, req.agent)
    if (halted || merged.decision === 'deny') return 'rejected'
    if (merged.decision === 'allow') return 'allowed-once'
    return next()
  })

  // The three observe events that ride the session event firehose share one
  // observer and dispatch on the recorded event type (all emit-shaped).
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type === 'approval/decided' && event.data.outcome === 'rejected') {
      detached.track(runPoint('PermissionDenied', '', permissionDeniedPayload(ctx, session), { signal: detached.signal })
        .then((merged) => { turnSafety.detachedOutcome('PermissionDenied', merged) })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: PermissionDenied hook failed: ${String(error)}`) }))
      return
    }
    if (event.type === 'approval/asked') {
      detached.track(runPoint('Notification', 'permission_prompt', notificationPayload(ctx, session, event), { signal: detached.signal })
        .then((merged) => { turnSafety.detachedOutcome('Notification', merged) })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: Notification hook failed: ${String(error)}`) }))
      return
    }
    // `compaction/end` is declared by the compaction plugin's augmentation (not the
    // core session map), so compare the type as a widened string; the payload here
    // only needs the session.
    if ((event.type as string) === 'compaction/end') {
      detached.track(runPoint('PostCompact', '', postCompactPayload(ctx, session), { signal: detached.signal })
        .then((merged) => { turnSafety.detachedOutcome('PostCompact', merged) })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: PostCompact hook failed: ${String(error)}`) }))
    }
  })

  // SessionEnd → a disposed session. CC's `reason` is not derivable from the
  // harness seam, so it is reported as `'other'`. F1 cleanup: every stop-block
  // counter and session pairing recorded for THIS session is freed (the maps
  // are keyed by agent.id, paired to its session id at first block).
  ctx.on('session/disposed', (session: Session) => {
    turnSafety.releaseSession(session.header.id)
    detached.track(runPoint('SessionEnd', '', sessionEndPayload(ctx, session), { signal: detached.signal })
      .then((merged) => { turnSafety.detachedOutcome('SessionEnd', merged) })
      .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: SessionEnd hook failed: ${String(error)}`) }))
  })

  // StopFailure → an agent/error, with the error mapped onto CC's error-code
  // vocabulary where possible (default `unknown`).
  ctx.on('agent/error', ({ agent, error }) => {
    detached.track(runPoint('StopFailure', '', stopFailurePayload(ctx, agent, error), { agent, signal: detached.signal })
      .then((merged) => { turnSafety.detachedOutcome('StopFailure', merged, agent) })
      .catch((failure: unknown) => { ctx.logger.warn(`hooks-claude-code: StopFailure hook failed: ${String(failure)}`) }))
  })

  // TaskCreated → bridge-side diff of the jobs registry: subscribe to changes,
  // re-read the visible snapshot, and emit once per newly-appeared job id. Reads
  // with no owner (unowned-only visible set); priming suppresses pre-existing jobs.
  const jobs = ctx.get?.('jobs')
  if (jobs) {
    const seenJobs = new Set<JobId>()
    const diffJobs = (owner: Agent | undefined): void => {
      for (const job of jobs.list(owner)) {
        if (seenJobs.has(job.id)) continue
        seenJobs.add(job.id)
        detached.track(runPoint('TaskCreated', '', taskCreatedPayload(ctx, job), { signal: detached.signal })
          .then((merged) => { turnSafety.detachedOutcome('TaskCreated', merged) })
          .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: TaskCreated hook failed: ${String(error)}`) }))
      }
    }
    for (const job of jobs.list(undefined)) seenJobs.add(job.id) // prime
    jobs.onJobsChanged(diffJobs)
  }

  // TeammateIdle → a subagent (non-root) transitioning to idle. `agent/status`
  // does not distinguish root from child, so only agents seen as subagents fire.
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle' && subagentIds.has(agent.id)) {
      detached.track(runPoint('TeammateIdle', '', teammateIdlePayload(ctx, agent), { agent, signal: detached.signal })
        .then((merged) => { turnSafety.detachedOutcome('TeammateIdle', merged, agent) })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: TeammateIdle hook failed: ${String(error)}`) }))
    }
  })
}
