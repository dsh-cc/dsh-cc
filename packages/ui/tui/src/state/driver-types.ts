/**
 * Structural Driver interface for UI components. Components import from here
 * (not from harness/driver.ts) so the boundary gate keeps harness imports
 * out of the view layer.
 * @module @dsh-cc/tui/state/driver-types
 */

import type { CatalogEntry } from '../model-catalog.ts'
import type { TuiState } from '../store.ts'
import type { ToolCallView, ToolResultView } from '../tool-card.ts'
import type { WorktreeExitHooks } from '../harness/worktree-exit.ts'

/**
 * The approval answers: grant once, grant persistently, grant for this
 * session, reject.
 */
export type ApprovalAnswerKind = 'once' | 'always' | 'session' | 'reject'

export interface Driver {
  readonly state: TuiState
  readonly statusLine: string
  /**
   * Width-aware status line: same content as {@link Driver.statusLine}, but
   * the parenthetical context detail is omitted when the line would not fit
   * `width` columns. Without a width the full line is returned.
   */
  statusLineIn(width?: number): string
  /** Session working directory, used for `@`-path completion. */
  readonly cwd: string
  /**
   * Persisted composer history (oldest→newest) loaded at boot from
   * `~/.dsh/tui/history.txt`. Seeds the editor's ↑/↓ recall; new prompts are
   * appended on submit (see {@link Driver.submit}). Read once at mount.
   */
  readonly promptHistory: readonly string[]
  /**
   * Bash-mode command history (newest-first, live reference). Every command
   * executed through a leading `!` is prepended here and persisted to
   * `~/.dsh/tui/bash-history.txt`; the root component browses this stack
   * with ↑/↓ while in shell mode — deliberately separate from the composer
   * prompt history.
   */
  readonly bashHistory: readonly string[]
  subscribe(listener: (state: TuiState) => void): () => void
  setDraft(draft: string): void
  submit(text?: string): Promise<void>
  interrupt(): void
  /**
   * Queue-jump (Ctrl+S): inject every queued outbox entry into the running
   * turn immediately — FIFO `agent.steer` per entry, with the queue cleared
   * in the same synchronous stroke as the dispatch. A no-op when the queue
   * is empty.
   */
  steerQueued(): void
  /**
   * Pop the LAST queued entry (LIFO — the most recent submit) back out of
   * the outbox for editing (empty-composer ↑). Returns the text, or
   * `undefined` when the queue is empty (same-reference no-op).
   */
  recallQueued(): string | undefined
  /**
   * Ctrl+B promotion of a foreground subagent wait (UX plan §3.4): promote
   * EVERY armed foreground collect of the CURRENT session to background via
   * the root-realm `ccCollectorRegistry`. Gated by the
   * `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` kill switch and by the registry
   * being resolvable — with nothing promotable (no registry, no armed
   * collect, or env kill switch armed) this is a `0` no-op. Returns the
   * number of promoted collects (the TUI echoes one status line when > 0).
   * Optional: drivers without the seam degrade to no promotion.
   */
  promoteForegroundCollects?(): number
  /**
   * Advance the Shift+Tab permission-mode cycle. Mode writes are serialized
   * per driver; the returned promise settles when this step's write chain
   * (command-channel dispatch + engine setMode) has finished, so tests and
   * callers that care about ordering can await it.
   */
  cyclePermissionMode(): Promise<void>
  /**
   * Flip the global collapse state (Ctrl+O): thinking rows and tool output
   * collapse together, or both expand back. Supersedes {@link Driver.toggleThinking},
   * which is retained for compatibility.
   */
  toggleGlobalCollapse(): void
  /** Legacy thinking-only flip; kept for compatibility with Ctrl+O's old behavior. */
  toggleThinking(): void
  /**
   * Answer the open approval prompt: `'once'` grants this call only;
   * `'always'` additionally derives a permission rule from the prompt's
   * preview and persists it into the settings `permissions.allow` list;
   * `'session'` derives the same rule and grants it for the current session
   * only (session-scoped allowlist — never persisted to global settings);
   * `'reject'` refuses the call.
   */
  answerApproval(kind: ApprovalAnswerKind): void
  /**
   * While a question overlay is open: move the focus one row across the
   * options and the trailing free-text ("Other") row.
   */
  questionMove(delta: -1 | 1): void
  /**
   * Activate the focused row: a multi-select question toggles the option in
   * `selected`; a single-select question resolves immediately with that
   * option's label; on the "Other" row a space is typed into the buffer.
   */
  questionToggle(): void
  /**
   * Jump to option `index` (0-based) and activate it — single-select
   * resolves, multi-select toggles. Out-of-range indexes are ignored. This is
   * the digit quick-pick path (keys 1-9).
   */
  questionPick(index: number): void
  /** Append free text to the "Other" buffer and focus that row. */
  questionType(text: string): void
  /** Edit the "Other" buffer (drops the last character). */
  questionBackspace(): void
  /**
   * Resolve the open question: the toggled labels for multi-select, or the
   * focused option when nothing is chosen and the buffer is empty; a
   * non-empty "Other" buffer is sent as `custom` (with an empty `selected`
   * when no option was picked).
   */
  questionSubmit(): void
  /** Dismiss the overlay resolving the first option (legacy escape behavior). */
  questionCancel(): void
  /**
   * Open the `/model` picker overlay: loads the catalog, parks `modelPicker`
   * state focused on the current route, or falls back to the status-row
   * notice when the catalog is empty. The arg path (`/model <n|provider/id>`)
   * bypasses the overlay and stays scriptable.
   */
  openModelPicker(): Promise<void>
  /** Move the model-picker focus by one row (clamped; no wrap). */
  modelPickerMove(delta: -1 | 1): void
  /**
   * Select the focused entry and close the overlay synchronously; the model
   * write (with its effort-preserve validation) settles asynchronously, so
   * awaiting the returned promise waits for the selection to be updated.
   */
  modelPickerSubmit(): Promise<void>
  /** Close the overlay without changing the selection. */
  modelPickerCancel(): void
  /**
   * Open the `/effort` picker overlay: resolves the current model's advertised
   * effort levels and parks `effortPicker` state focused on the live effort
   * (the trailing `default` entry when none is set). Fail closed — an
   * unresolved model or unresolvable levels emit a status notice instead of
   * opening a fabricated list. The arg path (`/effort <level|default>`)
   * bypasses the overlay and stays scriptable.
   */
  openEffortPicker(): Promise<void>
  /** Move the effort-picker focus by one row (clamped; no wrap). */
  effortPickerMove(delta: -1 | 1): void
  /**
   * Select the focused entry and close the overlay synchronously; validation
   * and the selection write settle asynchronously behind a stale-pair guard
   * (a concurrent `/model` or session switch refuses the parked write).
   * Awaiting the returned promise waits for that write to settle.
   */
  effortPickerSubmit(): Promise<void>
  /** Close the overlay without changing the selection. */
  effortPickerCancel(): void
  /**
   * Open the `/permissions` picker overlay: parks `permissionPicker` state
   * focused on the live mode. The argued path (`/permissions <mode>`)
   * bypasses the overlay and stays scriptable through the host command.
   */
  openPermissionPicker(): Promise<void>
  /** Move the permission-picker focus by one row (clamped; no wrap). */
  permissionPickerMove(delta: -1 | 1): void
  /**
   * Select the focused entry. `bypassPermissions` first parks an in-overlay
   * confirmation; a second submit (or any other mode) closes the overlay
   * synchronously and writes `/permissions ${id}` through the host command.
   * Awaiting the returned promise waits for that write to settle.
   */
  permissionPickerSubmit(): Promise<void>
  /**
   * Close the overlay without changing the mode. While the bypass
   * confirmation is showing, cancel returns to the list instead.
   */
  permissionPickerCancel(): void
  /**
   * Open the `/resume` session-switcher overlay: loads the session list,
   * sorts it by last activity, filters it to the current project's cwd (Tab
   * toggles to all projects), parks `sessionSwitcher` state focused on the
   * current session, and decorates titles asynchronously — or falls back to
   * a status-row notice when no sessions exist at all. The arg path
   * (`/resume <id>`) bypasses the overlay and switches directly.
   */
  openSessionSwitcher(): Promise<void>
  /** Move the session-switcher focus by one row (clamped; no wrap). */
  sessionSwitcherMove(delta: -1 | 1): void
  /** Append text to the picker's query filter and re-filter (focus resets). */
  sessionSwitcherType(text: string): void
  /** Drop the picker query's last character (no-op when empty) and re-filter. */
  sessionSwitcherBackspace(): void
  /** Flip the picker scope between this project's cwd and all projects. */
  sessionSwitcherToggleScope(): void
  /** Switch to the focused session (await {@link Driver.switchSession}) and close the overlay. */
  sessionSwitcherSubmit(): Promise<void>
  /**
   * Two-stage escape: a non-empty query is cleared first (overlay stays
   * open); an empty query closes the overlay without switching.
   */
  sessionSwitcherCancel(): void
  /**
   * Toggle the Ctrl+T todo panel: open it focused on the first row when
   * closed (rendering a placeholder when the session has no todos), or close
   * it when open. Pure store evolution — no harness calls.
   */
  toggleTodoPanel(): void
  /** Move the todo-panel focus by one row (clamped; no wrap). */
  todoPanelMove(delta: -1 | 1): void
  /** Close the todo panel. */
  todoPanelClose(): void
  /**
   * Close the `/usage` panel (Esc). The panel is pure display — opening is
   * owned by the `/usage` command — so closing is its only interaction.
   */
  usagePanelClose(): void
  /**
   * Move the `/quit` worktree-exit confirmation focus by one row (clamped;
   * no wrap). Overlay options: 0 keep, 1 remove, 2 cancel.
   */
  worktreeExitMove(delta: -1 | 1): void
  /**
   * Confirm the focused worktree-exit option. Keep exits normally; Remove
   * runs the cleanup and only exits on success (failure keeps the session
   * alive); Cancel dismisses the overlay. No-op while `busy`.
   */
  worktreeExitSubmit(): Promise<void>
  /**
   * Dismiss the worktree-exit overlay without quitting. No-op while `busy`.
   */
  worktreeExitCancel(): void
  /**
   * Show a one-line transient notice above the composer. The notice clears
   * itself after `ttlMs` (default 3000); a newer notice replaces the pending
   * clear timer of the previous one.
   */
  showNotice(text: string, ttlMs?: number): void
  /**
   * Record the moment of an idle Ctrl+C press — the anchor for the
   * double-press-to-exit window. Pure state evolution; callers pass the
   * timestamp they compared against so anchor and comparison share one clock
   * read. Defaults to `Date.now()`.
   */
  markExitAttempt(now?: number): void
  /**
   * Switch the live agent to a different persisted session in-process: dispose
   * the current handle, resume the target, replay its history through the same
   * fold the boot path uses, and reset the transcript. No-op when `id` matches
   * the current session. On failure the old session stays bound and a notice
   * is emitted.
   */
  switchSession(id: string): Promise<void>
  /** List persisted sessions (newest-first absent — the caller sorts). */
  listSessions(): Promise<readonly { id: string; cwd?: string; createdAt: number }[]>
  /**
   * Live LLM model catalog (`provider`/`id`/`name` per advertised model), the
   * same list `/model` resolves its argument against. Used by slash argument
   * completion; fetched per call so it never goes stale.
   */
  loadModelCatalog(): Promise<readonly CatalogEntry[]>
  /**
   * Reasoning-effort levels of the currently resolved model plus the trailing
   * `default` entry; `[]` when no model is resolved or its levels cannot be
   * resolved (no dead-end completions). Used by slash argument completion;
   * fetched per call so it never goes stale.
   */
  loadModelEfforts(): Promise<readonly string[]>
  /**
   * Merged slash-command catalog: TUI-local commands first, then harness
   * commands (deduped by name, local wins), then user-invocable skills from
   * the skills registry (a name claimed by a command resolves to the
   * command). The array identity is stable across calls until the catalog
   * changes (so callers can detect a refresh by reference equality).
   */
  listCommands(): readonly { name: string; description?: string; argumentHint?: string }[]
  dispose(): Promise<void>
}


// ---------------------------------------------------------------------------
// Driver configuration and structural service seams shared by
// harness/driver.ts and its extracted helper modules (usage-view,
// shell-output, approval-preview). Pure structure only — this file must not
// contain harness-package imports (check:tui-boundary), so the two seams that
// reference the agent type stay in harness/driver.ts.
// ---------------------------------------------------------------------------

/**
 * Configuration for the TUI harness driver. `branchProbe` defaults to
 * `gitBranchOf` (harness/shell-output); `exportDir` defaults to
 * `$DSH_HOME/tui/exports` (same resolution as `resume-target`).
 */
export interface DriverConfig {
  cwd?: string
  agentPreset?: string
  sessionId?: string
  /** Boot-time resume from the project resume marker (`sessionId` unset). */
  autoResume?: boolean
  /** `-c`/`--continue` requested — only affects the no-previous-session notice. */
  continueRequested?: boolean
  provider?: string
  model?: string
  /** Directory for the persisted history file (defaults to `$DSH_HOME/tui`). */
  historyDir?: string
  /** Git-branch probe for the statusline (best-effort); injectable for tests. */
  branchProbe?: (cwd: string) => Promise<string | undefined>
  /** Output directory for `/export-md` (default `$DSH_HOME/tui/exports`). */
  exportDir?: string
  /** Sink for the OSC 52 clipboard sequence `/copy` emits; injectable. */
  copyWrite?: (sequence: string) => void
  /** `/quit` worktree-exit seam (probe/evidence/cleanup); injectable for tests. */
  worktreeExit?: WorktreeExitHooks
  /** Quit finalizer invoked after a `/quit` decision settles. */
  onQuit?: () => void
}

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

export type PersistenceLike = {
  list(signal?: AbortSignal): Promise<{
    id: string
    cwd?: string
    createdAt: number
    updatedAtMs?: number
    parentSession?: string
  }[]>
}

/**
 * Structural stand-in for the deployment's `sessionQuery` service: batch
 * title reads for the /resume picker. One result per requested id —
 * operational failures are isolated per id (`status: 'rejected'`), and the
 * fulfilled value carries the session header plus its latest title snapshot.
 */
export type SessionTitleResultLike =
  | {
    status: 'fulfilled'
    /** Requested session id — the join key. Do not use `value.session.id`. */
    sessionId: string
    value: { session: { id: string }; title?: { title: string } }
  }
  | { status: 'rejected'; sessionId?: string }

export type SessionQueryLike = {
  readTitleSnapshots(ids: readonly string[], signal?: AbortSignal): Promise<readonly SessionTitleResultLike[]>
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
 * resolve→run seam), which the tui package doesn't import. `resolve` fills
 * the request's defaults/caps; `run` executes the resolved spec and reports
 * the first-cause outcome. Absent service → the driver degrades to a direct
 * child process (see `runShellCommand`).
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

export type ShellExecutorLike = {
  resolve(request: ShellExecRequestLike): ShellExecSpecLike
  run(spec: ShellExecSpecLike): Promise<ShellRunResultLike>
}

/**
 * Structural stand-in for the sessionProjections registry
 * (dsh-session-projection package, via token-meter's augmentation),
 * which the tui package doesn't import — same pattern as the other `*Like`
 * seams. `onChanged` fires once per client-visible unit whose state changed;
 * `stateOf` is the live read (undefined when the key is not registered).
 */
export type SessionProjectionsLike = {
  onChanged(listener: (session: { id: unknown }, key: string, value: unknown, seq: number) => void): () => void
  stateOf(session: unknown, key: string): unknown
}

export type {
  ContextBreakdownStateLike,
  ContextPressureStateLike,
  TokenUsageStateLike,
  TokenUsageTotals,
} from './driver-usage-types.ts'

/**
 * Structural seam for the deployment settings provider: the pieces the
 * always-allow write path needs (namespace descriptors and whole-section
 * replace). Declared locally — the tui package does not import the settings
 * package, mirroring the other `*Like` seams.
 */
export type SettingsProviderLike = {
  readonly writable?: boolean
  describe(options?: { redactSecrets?: boolean }): readonly {
    ns: unknown
    revision: number
    user?: unknown
  }[]
  replace(ns: unknown, section: object, expectedRevision?: number): Promise<void>
}
