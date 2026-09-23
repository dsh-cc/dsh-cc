/**
 * Browser-safe durable workflow-record events written by the CC-parity
 * workflow tool into its calling parent Session. The four event types are the
 * harness `tool-workflow` names verbatim (the harness tool row is disabled in
 * the cc preset, so there is no double emitter, and the harness web client
 * renders them for free); `run-start` gains one dsh-cc extension field,
 * `source`, for later `/learn` class analysis. Additive fields do not break
 * the harness renderer.
 *
 * @module @dsh-cc/tool-workflow/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  WorkflowAgentOutcome, WorkflowRunId, WorkflowStopReason,
} from '@deepseek-ai/dsh-workflow/types'

/** Where the launched script came from (dsh-cc extension on `run-start`). */
export type ToolWorkflowRunSource = 'inline' | 'project-saved' | 'user-saved' | 'scriptPath'

/** Opens one durable top-level workflow run record. */
export interface ToolWorkflowRunStartData {
  readonly runId: WorkflowRunId
  readonly name: string
  /** dsh-cc extension: the resolved script source class. */
  readonly source: ToolWorkflowRunSource
  /** dsh-cc extension (resume slice): the prior run this run resumes, when launched with `resumeFromRunId`. */
  readonly resumeOf?: WorkflowRunId
}

/** Records one workflow member after its child Session is published. */
export interface ToolWorkflowAgentStartData {
  readonly runId: WorkflowRunId
  readonly seq: number
  readonly label: string
  readonly phase?: string
  readonly childId: SessionId
  /** dsh-cc extension (resume slice): replayed from the source journal, not run live. */
  readonly cached?: boolean
}

/** Settles one previously started workflow member. */
export interface ToolWorkflowAgentEndData {
  readonly runId: WorkflowRunId
  readonly seq: number
  readonly outcome: WorkflowAgentOutcome
  /** dsh-cc extension (resume slice): replayed from the source journal, not run live. */
  readonly cached?: boolean
}

/** Settles one workflow run after its live resources reach quiescence. */
export interface ToolWorkflowRunEndData {
  readonly runId: WorkflowRunId
  readonly stopReason: WorkflowStopReason
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Opens one top-level workflow record.
     * @param data - stable run identity, display name, and source class.
     */
    'tool-workflow/run-start': ToolWorkflowRunStartData
    /**
     * Records one published workflow member.
     * @param data - run identity, member sequence, display identity, and child Session.
     */
    'tool-workflow/agent-start': ToolWorkflowAgentStartData
    /**
     * Records one member settlement.
     * @param data - run identity, paired member sequence, and outcome.
     */
    'tool-workflow/agent-end': ToolWorkflowAgentEndData
    /**
     * Closes one workflow record after cleanup.
     * @param data - stable run identity and terminal reason.
     */
    'tool-workflow/run-end': ToolWorkflowRunEndData
  }
}
