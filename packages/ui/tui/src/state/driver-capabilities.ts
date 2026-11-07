/**
 * Capability types the Driver interface references. Split from
 * driver-types.ts to keep both files under the size gate.
 * @module @dsh-cc/tui/state/driver-capabilities
 */

import type { ToolCallView, ToolResultView } from '../tool-card.ts'

export type ToolsLike = {
  get(name: string, scope?: unknown): {
    presentCall?(args: unknown): ToolCallView | undefined
    presentResult?(args: unknown, result: { content: unknown; isError: boolean; meta?: unknown }): ToolResultView | undefined
  } | undefined
}

/**
 * Structural stand-in for the deployment's `agentDefaultModel` service
 * (settings.yaml's `agent-default-model`), which the headless bundle seeds
 * agents from. `currentSelection()` returns the resolved default or undefined
 * when no default is configured. A carried `reasoningEffort` is seeded into
 * the selection too — but only after the llm service confirms the model
 * advertises it ({@link resolveEfforts}); an invalid or unresolvable effort is
 * silently dropped to the bare pair, which is always legal.
 */
export type AgentDefaultModelLike = {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string } | undefined
}

export type LlmLike = {
  listProviders(): { id: string }[]
  listModels(provider: string): Promise<{ provider: string; id: string; name: string }[]>
  /**
   * Optional model-metadata lookup used to validate reasoning-effort writes.
   * Optional so existing llm stubs without it keep working: every effort
   * consumer treats absence as "unresolvable" and fails closed (or writes the
   * bare pair for /model, which never needs validation).
   */
  resolveModelInfo?(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{
    reasoning?: {
      efforts: readonly { id: string; name: string; description?: string }[]
      defaultEffort?: string
    }
  }>
}

/**
 * `subagent/start` snapshot. The real `SubagentRunInfo` is declared in
 * the subagent package (via cordis module augmentation), which the tui
 * package doesn't import — so a structural local type stands in. Fields are
 * `unknown` because the driver stringifies them into the view layer.
 */
export type SubagentRunInfoLike = {
  runId: unknown
  provider: unknown
  id: unknown
  local: boolean
}

/**
 * `subagent/end` snapshot. `stopReason` and `lastAssistantMessage` are
 * optional on the payload; only `stopReason` is surfaced to the view.
 */
export type SubagentRunEndInfoLike = {
  runId: unknown
  provider: unknown
  id: unknown
  local: boolean
  stopReason?: unknown
  lastAssistantMessage?: unknown
}

/**
 * Structural stand-in for the deployment's `shell` service (ShellExecutor's
 * resolve→execute seam), which the tui package doesn't import. `resolve` fills
 * the request's defaults/caps; `execute` prepares the resolved spec and hands
 * back a handle whose `result()` settles with the first-cause outcome. Absent
 * service → the driver degrades to a direct child process (see
 * `runShellCommand`).
 */
export type ShellExecSpecLike = {
  command: string
  workdir: string
  timeoutMs: number
  stdoutMaxBytes: number
  /** Stdin bytes handed to the child (resolve bakes the request's in). */
  stdin?: string
  /** Abort signal wiring the caller's cancellation into the child. */
  signal?: AbortSignal
  /** Extra/overriding environment entries (resolve bakes the request's in). */
  env?: Record<string, string>
}

export type ShellRunResultLike = {
  /** Exit code; null when the process died from a signal. */
  exitCode: number | null
  /** True when the executor's timeout was the first cause to cut the command. */
  timedOut: boolean
  stdout: { text: string }
  stderr: { text: string }
}

export type ShellExecRequestLike = {
  command: string
  timeoutMs?: number
  stdoutMaxBytes?: number
  /** Stdin bytes handed to the child (e.g. the status-line JSON payload). */
  stdin?: string
  /** Abort signal wiring the caller's cancellation into the child. */
  signal?: AbortSignal
  /** Environment entries merged over the inherited process env. */
  env?: Record<string, string>
  /** Working directory for the child (the harness executor's field name). */
  workdir?: string
}

/** rc.2 shell seam: `execute` returns a handle whose `result()` rejects only on infra faults. */
export type ShellExecutionLike = {
  result(): Promise<ShellRunResultLike>
}
export type ShellExecutorLike = {
  resolve(request: ShellExecRequestLike): ShellExecSpecLike
  execute(spec: ShellExecSpecLike): Promise<ShellExecutionLike>
}

/**
 * Structural stand-in for the sessionProjections registry (same `*Like` seam
 * pattern; tui doesn't import it). `onChanged` fires per changed unit;
 * `stateOf` is the live read (undefined when the key is not registered).
 */
