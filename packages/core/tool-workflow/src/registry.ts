/**
 * Session-scoped workflow run registry (plan §3.5): the cordis service
 * `ccWorkflowRunRegistry` tracks in-flight runs launched by the CC-parity
 * `workflow` tool, projects the four durable `tool-workflow/*` session
 * events, enforces the single-active-run constraint, cancels in-flight runs
 * on context disposal, and delivers the consolidated completion by the
 * two-vein design:
 *
 * - **Session busy** — the payload joins the `agent/pre-step` batch as a
 *   `createUserMessage` appended to the enter decision's messages
 *   (`mcpReadyNotice.ts` pattern): lands at the next step boundary, never
 *   re-opens anything, never enters the pending inbox, by construction.
 * - **Session idle** — exactly-once wake: `agent.inject()` of one pending
 *   completion message whose per-runId delivery happens at most once (the
 *   registry entry drops at settle, before enqueue). This deliberately uses
 *   the `hasPending` re-open once per run — a workflow completion is a
 *   background-task result the user asked for, so one idle wake is a
 *   requirement, not a hazard (the PR #31 phantom-wake mistake was the
 *   passive, ownerless content, not the re-open primitive).
 *
 * @module @dsh-cc/tool-workflow/registry
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { WorkflowResult, WorkflowRun, WorkflowRunId, WorkflowStopReason } from '@deepseek-ai/dsh-workflow'
import type { ToolWorkflowRunSource, ToolWorkflowRunStartData, ToolWorkflowAgentStartData, ToolWorkflowAgentEndData, ToolWorkflowRunEndData } from './types.ts'

/** MessageSourceMap kind for the workflow completion wake (recall-facing). */
export const WORKFLOW_COMPLETION_SOURCE_KIND = 'cc-workflow-completion'

declare module '@deepseek-ai/cordis' {
  interface Context {
    ccWorkflowRunRegistry: CcWorkflowRunRegistry
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    ccWorkflowCompletion: { kind: 'cc-workflow-completion' }
  }
}

/** One registered in-flight run and everything delivery composition needs. */
export interface CcWorkflowRunEntry {
  readonly run: WorkflowRun
  readonly meta: { name: string; description: string }
  readonly args: unknown
  readonly scriptText: string
  readonly source: ToolWorkflowRunSource
  readonly startedAt: number
  readonly session: Session
  readonly agent: Agent
  /** Rendered-result ceiling applied to the returned JSON value. */
  readonly maxResultChars: number
  /** Durable-event recording flag: top-level calls only (§3.6, harness precedent `exec.parent === undefined`). */
  readonly record: boolean
}

/** Render any thrown value without trusting it. */
function renderError(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/** Compose the consolidated delivery text for a settled run (plan §3.5.3). */
export function composeDeliveryText(entry: CcWorkflowRunEntry, result: WorkflowResult): string {
  const name = entry.meta.name
  switch (result.stopReason) {
    case 'completed': {
      const agents = result.agentsStarted
      const rendered = JSON.stringify(result.value, null, 2)
      const capped = rendered.length > entry.maxResultChars
        ? `${rendered.slice(0, entry.maxResultChars)}\n… [truncated: ${rendered.length - entry.maxResultChars} more characters]`
        : rendered
      return `Workflow "${name}" completed (${agents} agent${agents === 1 ? '' : 's'}).\nReturn value:\n${capped}`
    }
    case 'cancelled':
      return `Workflow "${name}" was cancelled${result.error !== undefined ? ` (${result.error})` : ''}. No result returned.`
    case 'error':
      return `Workflow "${name}" failed: ${result.error ?? 'unknown error'}. No result returned.`
    /* v8 ignore start -- WorkflowStopReason is a closed union, exhaustive by construction. */
    default:
      return `Workflow "${name}" ended abnormally (${String(result.stopReason satisfies never)}). No result returned.`
    /* v8 ignore stop */
  }
}

function stopReasonOf(result: WorkflowResult): WorkflowStopReason {
  return result.stopReason
}

/**
 * Package-internal cordis service. Unpublished to the model; the sibling
 * resume-journal package consumes the same run table through this service
 * instead of importing package internals.
 */
export class CcWorkflowRunRegistry extends Service {
  private readonly runs = new Map<WorkflowRunId, CcWorkflowRunEntry>()
  /** Busy-vein queue: consolidated payloads awaiting the next enter decision. */
  private readonly pending = new Map<string, ReturnType<typeof createUserMessage>[]>()
  private disposed = false

  /** Typed Context accessor (augmented below). */
  declare ctx: Context

  constructor(ctx: Context) {
    super(ctx, 'ccWorkflowRunRegistry')
    ctx.on('workflow/agent-start', (info, agent) => {
      const entry = this.runs.get(info.id)
      if (entry === undefined || !entry.record) return
      this.appendRecord(entry.session, 'tool-workflow/agent-start', {
        runId: info.id,
        seq: agent.seq,
        label: agent.label,
        ...agent.phase === undefined ? {} : { phase: agent.phase },
        childId: agent.childId,
      })
    })
    ctx.on('workflow/agent-end', (info, agent) => {
      const entry = this.runs.get(info.id)
      if (entry === undefined || !entry.record) return
      this.appendRecord(entry.session, 'tool-workflow/agent-end', {
        runId: info.id,
        seq: agent.seq,
        outcome: agent.outcome,
      })
    })
    // Busy vein: on each enter decision, claim every pending completion for
    // this session into the decision's message batch (never the inbox).
    ctx.on('agent/pre-step', async (payload: { agent?: Agent }, next) => {
      const decision = await next()
      try {
        if (decision.kind !== 'enter') return decision
        const sid = payload.agent === undefined ? undefined : String(payload.agent.session?.id)
        if (sid === undefined) return decision
        const queued = this.pending.get(sid)
        if (queued === undefined || queued.length === 0) return decision
        this.pending.delete(sid)
        return { ...decision, messages: [...decision.messages, ...queued] }
      } catch {
        return decision
      }
    })
  }

  /** Durable, log-only session event append with the try/catch-drop guard. */
  private appendRecord(
    session: Session,
    type: 'tool-workflow/run-start' | 'tool-workflow/agent-start' | 'tool-workflow/agent-end' | 'tool-workflow/run-end',
    data: ToolWorkflowRunStartData | ToolWorkflowAgentStartData | ToolWorkflowAgentEndData | ToolWorkflowRunEndData,
  ): void {
    // The four package-owned events are all log-only. Narrowing the generic
    // append face here discharges Session.append's conditional options tuple.
    const append = session.append.bind(session) as (t: string, d: unknown) => void
    try {
      append(type, data)
    } catch (error) {
      this.ctx.logger.warn(`tool-workflow: disabled durable record after ${type} append failed: ${renderError(error)}`)
    }
  }

  /** Structured refusal surface: true when a run is already in flight. */
  inFlightRunId(): WorkflowRunId | undefined {
    for (const runId of this.runs.keys()) return runId
    return undefined
  }

  /** Busy-vein inspection surface: queued (undelivered) completions for one session. */
  pendingFor(sessionId: string): readonly unknown[] {
    return this.pending.get(sessionId) ?? []
  }

  /**
   * Register a successfully started run. Single-active-run v1: a second
   * concurrent run is refused with a structured error naming the in-flight
   * runId (the resume slice attributes journal entries through signal
   * identity, which is sound only under this constraint).
   */
  register(entry: CcWorkflowRunEntry): void {
    const inFlight = this.inFlightRunId()
    if (inFlight !== undefined) {
      throw new Error(`workflow: run ${inFlight} is already active in this session; only one workflow run may be in flight at a time (cancel it or wait for its completion delivery before launching another)`)
    }
    this.runs.set(entry.run.id, entry)
    if (entry.record) {
      this.appendRecord(entry.session, 'tool-workflow/run-start', {
        runId: entry.run.id,
        name: entry.meta.name,
        source: entry.source,
      })
    }
    void entry.run.result.then((result) => { this.settle(entry.run.id, result) })
  }

  /**
   * Settle one registered run: drop the registry entry (no second wake can
   * be composed), append the durable `run-end` record, then deliver by vein.
   * After disposal has begun, delivery composition is swallowed entirely.
   */
  private settle(runId: WorkflowRunId, result: WorkflowResult): void {
    const entry = this.runs.get(runId)
    if (entry === undefined) return
    this.runs.delete(runId)
    if (entry.record) {
      this.appendRecord(entry.session, 'tool-workflow/run-end', { runId, stopReason: stopReasonOf(result) })
    }
    if (this.disposed) return
    const text = composeDeliveryText(entry, result)
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'cc-workflow-completion' },
    })
    if (entry.agent.status === 'idle') {
      // Idle vein: exactly-once wake via the pending-inbox re-open — the
      // message is enqueued durably and the loop re-opens a turn to claim it
      // (drain-on-read; the entry is already dropped, so no second wake can
      // be composed). `followup` is the wake-carrying send: `inject` queues
      // without wakeup, which never opens a turn for an idle loop (the
      // tool-jobs idle-owner precedent). A torn-down loop drops the notice
      // quietly (try/catch-drop precedent).
      try {
        entry.agent.followup(message)
      } catch {
        // Delivery falls back to the next user interaction; never crash the host.
      }
      return
    }
    // Busy vein: queue for the next enter decision's message batch.
    const sid = String(entry.agent.session?.id)
    const queued = this.pending.get(sid)
    if (queued === undefined) this.pending.set(sid, [message])
    else queued.push(message)
  }

  /**
   * Cancel and dispose every in-flight run and disarm delivery. Called from
   * context disposal; safe to call directly.
   */
  disposeAll(): void {
    this.disposed = true
    for (const [runId, entry] of this.runs) {
      this.runs.delete(runId)
      try {
        entry.run.cancel('session ended')
      } catch {
        // A run that cannot be cancelled still drops its delivery below.
      }
      void Promise.resolve(entry.run.dispose()).catch(() => {})
    }
    this.pending.clear()
  }
}

/**
 * Mount the registry inside a plugin body: the returned disposer cancels every
 * in-flight run and disarms delivery when the owning plugin fiber unloads
 * (settle-vs-disposal swallow: once disposal has begun, settle composes
 * nothing instead of waking a torn-down loop).
 */
export function mountCcWorkflowRunRegistry(ctx: Context): () => void {
  new CcWorkflowRunRegistry(ctx)
  return () => ctx.ccWorkflowRunRegistry.disposeAll()
}
