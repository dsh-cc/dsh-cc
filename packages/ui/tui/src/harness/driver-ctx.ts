/**
 * Driver cluster context: structural interface(s) that free-function
 * collaborators (harness/driver-*.ts) use instead of importing the createDriver
 * factory (which would be a cycle). This file is a type-only leaf — every new
 * cluster that migrates out of driver.ts grows a `*.Ctx` here.
 *
 * All TS-only; erased at runtime.
 * @module @dsh-cc/tui/harness/driver-ctx
 */

import type { TuiState, UsageView } from '../store.ts'
import type {
  DriverConfig,
  SessionProjectionsLike,
  ShellExecutorLike,
} from '../state/driver-types.ts'
import type {
  Agent,
  AgentHandle,
  AgentSetup,
  ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CatalogEntry } from '../model-catalog.ts'
import type { ModalEntry } from './driver-modal.ts'
import type { OnboardingGate } from './onboarding.ts'
import type { StatusLineSectionHandle } from './statusline-wiring.ts'
import type { SessionEventLike, ToolPresenters } from '../transcript.ts'

/**
 * The slice of createDriver's closed-over state that `!` shell-command
 * execution needs. `state()` returns the CURRENT view-model value — createDriver
 * rebinds `state` on every emit, so collaborators must read it through a getter
 * rather than capturing a stale snapshot.
 */
export interface DriverBashCtx {
  /** Publish the next view-model value (rebinds createDriver's `state`). */
  emit(next: TuiState): void
  /** Read the current view-model value (fresh, not a snapshot). */
  state(): TuiState
  /** Working directory for fallback `/bin/sh -c` runs. */
  cwd: string
  /** Shell executor when mounted; undefined degrades to a direct child run. */
  shell: ShellExecutorLike | undefined
  /** Record a command in bash-mode history (dedup + cap + persist). */
  appendBashHistory(command: string): void
}

/**
 * Structural face of the permission-rules service the mode section reads:
 * the merged rule set (for rule preview/derivation) and the durable mode
 * write. Mirrors the service's public surface without importing its package.
 */
export type PermissionRulesLike = {
  readonly ruleSet: {
    readonly allow: readonly unknown[]
    readonly deny: readonly unknown[]
    readonly ask: readonly unknown[]
    readonly bypassImmune: readonly unknown[]
  }
  setMode(agent: Agent, mode: string): void
}

/**
 * The slice of createDriver's closed-over state that the modal pipeline
 * (approvals + questions sharing one FIFO) needs. `state()` returns the CURRENT
 * view-model value — createDriver rebinds `state` on every emit, so the modal
 * collaborator must read it through a getter rather than a stale snapshot.
 */
export interface DriverModalCtx {
  /** Publish the next view-model value (rebinds createDriver's `state`). */
  emit(next: TuiState): void
  /** Read the current view-model value (fresh, not a snapshot). */
  state(): TuiState
}

/**
 * The slice of createDriver's closed-over state that the plan/mode writepath
 * needs (driver-mode.ts). `state()` returns the CURRENT view-model value —
 * createDriver rebinds `state` on every emit, so the collaborator must read it
 * through a getter rather than a stale snapshot.
 */
export interface DriverModeCtx {
  /** Publish the next view-model value (rebinds createDriver's `state`). */
  emit(next: TuiState): void
  /** Read the current view-model value (fresh, not a snapshot). */
  state(): TuiState
  /** The rebindable agent holder (switchSession replaces it in place). */
  current: { agent: Agent }
  /** Plan-unit projector, when mounted. */
  projections: { stateOf(session: unknown, unit: string): unknown } | undefined
  /** Surface a transient notice line. */
  showNotice(text: string): void
  /** Run a bare /plan channel command. Late-bound (defined after this ctx). */
  runHarness(line: string): Promise<{ kind: string; text?: string } | undefined | null>
  /** Returns the mounted permission-rules engine's setMode seam, if any. */
  getRules(): PermissionRulesSeam | undefined
  /** Fold the current plan/permission mode (live, not a snapshot). */
  liveMode(agent: Agent, fallback?: string): string
}

/** Duck-typed surface for the permission-rules engine's mode writepath. */
export interface PermissionRulesSeam {
  setMode(agent: Agent, mode: string): void
}

/**
 * The slice of createDriver's closed-over state that the statusline HUD /
 * sessionProjections feed needs (driver-hud.ts). `state()` returns the CURRENT
 * view-model value — createDriver rebinds `state` on every emit, so the
 * collaborator must read it through a getter rather than a stale snapshot.
 * `current` and `selection` are passed by reference (createDriver rebinds them
 * in place across switchSession), so the section always reads the live values.
 */
export interface DriverHudCtx {
  /** Publish the next view-model value (rebinds createDriver's `state`). */
  emit(next: TuiState): void
  /** Read the current view-model value (fresh, not a snapshot). */
  state(): TuiState
  /** Host context for the sessionProjections service lookup. */
  ctx: Context
  /** Working directory (process cwd, fallback for the branch probe). */
  cwd: string
  /** The rebindable agent holder (switchSession replaces it in place). */
  current: { agent: Agent }
  /** Model selection ref; statusline reads reasoningEffort/model from it. */
  selection: ModelSelectionRef
  /** Best-effort git-branch probe for the statusline footer. */
  branchProbe: (dir: string) => Promise<string | undefined>
  /**
   * Custom statusLine wiring (statusline-wiring.ts), when created by the
   * driver. `override()` returns the configured command's line while active,
   * or undefined so the built-in HUD stays in charge.
   */
  statusline?: StatusLineSectionHandle
}

/**
 * The slice of createDriver's closed-over state that the slash-command
 * catalog + subagent lifecycle section needs (driver-catalog.ts). `state()`
 * returns the CURRENT view-model value — createDriver rebinds `state` on every
 * emit, so the collaborator must read it through a getter rather than a stale
 * snapshot. `current` is the rebindable agent holder (list() reads the live
 * agent).
 */
export interface DriverCatalogCtx {
  /** Publish the next view-model value (rebinds createDriver's `state`). */
  emit(next: TuiState): void
  /** Read the current view-model value (fresh, not a snapshot). */
  state(): TuiState
  /** The rebindable agent holder (switchSession replaces it in place). */
  current: { agent: Agent }
  /** Host context for the commands/skills service lookups + event subscriptions. */
  ctx: Context
}

/**
 * The slice of createDriver's closed-over state that the approval + user
 * question pipeline needs (driver-approvals.ts). The section owns the modal
 * FIFO (via createModalQueue) so approvals and questions share one queue.
 * `state()` returns the CURRENT view-model value — createDriver rebinds
 * `state` on every emit, so the collaborator must read it through a getter
 * rather than a stale snapshot.
 */
export interface DriverApprovalsCtx {
  /** Publish the next view-model value (rebinds createDriver's `state`). */
  emit(next: TuiState): void
  /** Read the current view-model value (fresh, not a snapshot). */
  state(): TuiState
  /** Host context: settings/userQuestions lookup + approval/request hook. */
  ctx: Context
  /** The rebindable agent holder (approval listener reads the live id). */
  current: { agent: Agent }
  /** Surface a transient notice line (rule-persist outcomes and failures). */
  showNotice(text: string): void
}

/**
 * The slice of createDriver's closed-over state that the model/effort/
 * permission pickers need (driver-pickers.ts). `state()` returns the CURRENT
 * view-model value — createDriver rebinds `state` on every emit, so the
 * section must read it through a getter rather than a stale snapshot.
 * `selection` is passed by reference so writes land on createDriver's live
 * ref across switchSession. resolveEfforts / stalePair / loadCatalog stay in
 * createDriver and arrive on the ctx (they read `llm` off the host ctx).
 */
export interface DriverPickersCtx {
  /** Publish the next view-model value (rebinds createDriver's `state`). */
  emit(next: TuiState): void
  /** Read the current view-model value (fresh, not a snapshot). */
  state(): TuiState
  /** Model selection ref; the section reads current and rewrites it in place. */
  selection: ModelSelectionRef
  /** The rebindable agent holder (openPermissionPicker reads the live agent). */
  current: { agent: Agent }
  /** Fold the live plan/permission mode for the picker's focus row. */
  liveMode(agent: Agent, fallback?: string): string
  /** Resolve a model's advertisement list (never a fabricated list). */
  resolveEfforts(
    provider: string,
    model: string,
  ): Promise<readonly { id: string; name: string }[] | undefined>
  /** Stale-pair guard: refuse a detached write when the selection moved. */
  stalePair(captured: { provider: string; model: string }): boolean
  /** Build the full model catalog for the `/model` picker. */
  loadCatalog(): Promise<CatalogEntry[]>
  /** Run a bare /plan-/permissions channel command. Late-bound (after ini). */
  runHarness(line: string): Promise<{ kind: string; text?: string } | undefined | null>
}

/**
 * The slice of createDriver's closed-over state that the session switcher /
 * /resume section needs (driver-sessions.ts). `state()` returns the CURRENT
 * view-model value — createDriver rebinds `state` on every emit, so the
 * collaborator must read it through a getter rather than a stale snapshot.
 * `current` and `selection` are passed by reference (createDriver rebinds them
 * in place across switchSession), and the section writes both in place.
 */
export interface DriverSessionsCtx {
  /** Publish the next view-model value (rebinds createDriver's `state`). */
  emit(next: TuiState): void
  /** Read the current view-model value (fresh, not a snapshot). */
  state(): TuiState
  /** Host context for sessionPersistence/sessionQuery service lookup + agents.resume. */
  ctx: Context
  /** Create a brand-new agent handle for a minted session id (local /clear). */
  createHandle(
    id: SessionId,
    extras: { cwd: string; agentOptions?: { provider: string; model: string } },
  ): Promise<AgentHandle>
  /** Re-apply a captured permission mode on the NEW agent after bind. */
  reapplyMode(mode: string): Promise<void>
  /** Working directory (fallback when the live header cwd is absent). */
  cwd: string
  /** The rebindable agent holder (switchSession disposes old, binds new). */
  current: { handle: AgentHandle; agent: Agent }
  /** Model selection ref; switchSession reseeds it after the rebind. */
  selection: ModelSelectionRef
  /** Fold the live plan/permission mode for the new session. */
  liveMode(agent: Agent, fallback?: string): string
  /** Reset-and-reseed the model selection from the new agent's options. */
  seedDefaultModel(reset?: boolean): Promise<void>
  /** Fold the new session's history into a fresh TuiState. */
  foldHistory(): TuiState
  /** Re-seed the statusline HUD / todos / branch for the new session. */
  seedHud(): void
  seedTodos(): void
  refreshBranch(): void
  /** Persist the resume marker for a session id (idempotent). */
  writeResumeTarget(id: string): void
  /** Set the `markedContent` flag (createDriver owns the binding). */
  setMarkedContent(value: boolean): void
  /**
   * Rebind prompt/bash history onto the project of the switched session's
   * cwd (reloads both from disk). No-op for same-project switches and when
   * an explicit historyDir pins the bucket.
   */
  rebindHistory(sessionCwd: string | undefined): void
  /**
   * Pin a session id in the sidecar index of the project that owns
   * `sessionCwd` (falling back to the process cwd), so the /resume picker's
   * project scope has an exact membership record. Best-effort.
   */
  recordProjectSession(sessionId: string, sessionCwd: string | undefined): void
  /** Drain the shared approval/question FIFO (returns parked entries). */
  spliceAll(): ModalEntry[]
  /**
   * Rebuild the slash-command catalog for the (new) live agent: commands
   * synchronously, skills via a fresh snapshot. Called after a successful
   * session switch — `list()`/`snapshot()` are agent- and cwd-scoped and no
   * change event fires on a switch.
   */
  refreshCatalog(): void
  /** The agent setup closure (wraps presetSetup + installModelSelection). */
  withSelection: AgentSetup
  /** Explicit provider/model override, or undefined when unset. */
  agentOptions: { provider: string; model: string } | undefined
}

/**
 * The slice of createDriver's closed-over state that the `/export-md`, `/copy`,
 * runLocal (local slash-command) and runHarness (host command) pipeline needs
 * (driver-run-local.ts). `state()` returns the CURRENT view-model value —
 * createDriver rebinds `state` on every emit, so the collaborator must read it
 * through a getter rather than a stale snapshot. `current`, `selection`, and
 * `config` are passed by reference; `markedContent` is read through a getter
 * because createDriver owns the live `let` binding.
 */
export interface DriverRunLocalCtx {
  /** Publish the next view-model value (rebinds createDriver's `state`). */
  emit(next: TuiState): void
  /** Read the current view-model value (fresh, not a snapshot). */
  state(): TuiState
  /** Host context for the commands service lookup. */
  ctx: Context
  /** Working directory (resolution base for export paths). */
  cwd: string
  /** Driver configuration (exportDir, copyWrite, cwd, ...). */
  config: DriverConfig
  /** The rebindable agent holder (exports/cost/usage read the live agent). */
  current: { handle: AgentHandle; agent: Agent }
  /** Model selection ref; /effort and /model read and rewrite it in place. */
  selection: ModelSelectionRef
  /** Session projections feed for /cost and /usage (may be unmounted). */
  projections: SessionProjectionsLike | undefined
  /** Apply a usage-panel patch (HUD section's live-projections update fn). */
  applyUsage(patch: UsageView | undefined): void
  /** Surface a transient notice line. */
  showNotice(text: string): void
  /** /resume with an explicit id; the switch engine lives in driver-sessions. */
  switchSession(id: string): Promise<void>
  /** Bind a freshly created empty session (local /clear, /new, /reset). */
  startFreshSession(): Promise<void>
  /** Open the /resume overlay (session switcher picker). */
  openSessionSwitcher(): Promise<void>
  /** Open the model picker. */
  openModelPicker(): Promise<void>
  /** Validate + apply a provider/model switch (never blocks on the switch). */
  applyModelSwitch(provider: string, model: string): Promise<void>
  /** Open the effort picker. */
  openEffortPicker(): Promise<void>
  /** Build the full model catalog for the /model path. */
  loadCatalog(): Promise<CatalogEntry[]>
  /** Resolve a model's advertised reasoning-effort levels (or undefined). */
  resolveEfforts(
    provider: string,
    model: string,
  ): Promise<readonly { id: string; name: string }[] | undefined>
  /** Persist the resume marker (idempotent) — after first real content. */
  persistResumeTarget(): void
  /** Whether real content has been produced this boot (drives /quit resume). */
  getMarkedContent(): boolean
  /**
   * Set the `markedContent` flag (createDriver owns the binding). The
   * worktree remove path sets it `false` so dispose() does not re-persist a
   * resume marker pointing into the just-deleted worktree.
   */
  setMarkedContent(marked: boolean): void
  /** Await the boot default-model seed before /effort reads the selection. */
  waitForModel(): Promise<void>
  /** The driver's emit listener set (onboarding rides it as the diff seam). */
  listeners: Set<(state: TuiState) => void>
  /** Buffered boot no-model flag + the late-bound onboarding handle. */
  onboardingGate: OnboardingGate
}

/**
 * The slice of createDriver's closed-over state that the queue/outbox +
 * submit/interrupt pipeline needs (driver-queue.ts). `state()` returns the
 * CURRENT view-model value — createDriver rebinds `state` on every emit, so the
 * queue collaborator must read it through a getter rather than a stale snapshot.
 */
export interface DriverQueueCtx {
  /** Publish the next view-model value (rebinds createDriver's `state`). */
  emit(next: TuiState): void
  /** Read the current view-model value (fresh, not a snapshot). */
  state(): TuiState
  /** The rebindable agent holder (switchSession replaces it in place). */
  current: { agent: Agent }
  /** Host context for the optional ccPlugins service lookup. */
  ctx: Context
  /** Dispatch a local slash command (run-local section). */
  runLocal(name: string, rawInput: string): Promise<void>
  /** Dispatch a harness slash command (run-local section, late-bound). */
  runHarness(line: string): Promise<{ kind: string; text?: string } | undefined | null>
  /** Open the /permissions overlay picker (pickers section). */
  openPermissionPicker(): void
  /** Surface a transient notice line (e.g. an empty slash command). */
  showNotice(text: string): void
  /** Run a `!` bash-mode line (driver-bash section). */
  runShellCommand(raw: string): Promise<void>
  /** Read the current composer prompt history (oldest→newest). */
  getHistory(): string[]
  /** Replace the composer prompt history after a submit persist. */
  setHistory(next: string[]): void
  /** Directory backing prompt-history persistence (for saveHistory). */
  historyDir: string | undefined
  /** Persist the resume marker (idempotent) — after first real content. */
  persistResumeTarget(): void
  /** Mark/clear the session as having real content (drives /quit resume). */
  setMarkedContent(value: boolean): void
  /**
   * Await the boot default-model seed before dispatch/enqueue (W4): a turn
   * must never run with an unresolved selection. Resolves even on seed
   * failure (warned, never deadlocks submit).
   */
  waitForModel(): Promise<void>
}

/**
 * The slice of createDriver's closed-over state that the agent-model/history
 * cluster needs: resolveEfforts, seedDefaultModel, persistResumeTarget, the
 * prompt/bash histories, tool presenters, foldHistory, and loadCatalog all
 * read `ctx`/`current`/`selection` off `rt` instead of createDriver's locals.
 * The section returns handles createDriver threads into the other sections.
 */
export interface DriverAgentCtx {
  /** Publish the next view-model value (rebinds createDriver's `state`). */
  emit(next: TuiState): void
  /** Read the current view-model value (fresh, not a snapshot). */
  state(): TuiState
  /** Host context for llm/shell/tools service lookup. */
  ctx: Context
  /** The rebindable agent holder (re-read live at fire time). */
  current: { handle: AgentHandle; agent: Agent }
  /** Model selection ref; seeded by agent options / deployment default. */
  selection: ModelSelectionRef
  /** Explicit provider/model override, or undefined when unset. */
  agentOptions: { provider: string; model: string } | undefined
  /** Fold the live plan/permission mode for the agent. */
  liveMode(agent: Agent, fallback?: string): string
  /** Directory backing prompt/bash-history persistence. */
  historyDir: string | undefined
  /** Working directory the resume marker is keyed by. */
  cwd: string
  /**
   * Boot hook: the default-model seed settled with `selection.current`
   * still undefined (exactly once per boot). The onboarding wiring reacts
   * by offering the provider wizard.
   */
  onModelMissing?(): void
}

/**
 * The slice of createDriver's closed-over state the `session/event` listener
 * needs. It only reads the live view-model and current agent; the queue flush
 * is late-bound through a holder so the listener can be attached before the
 * queue section is constructed.
 */
export interface DriverSessionEventsCtx {
  /** Publish the next view-model value (rebinds createDriver's `state`). */
  emit(next: TuiState): void
  /** Read the current view-model value (fresh, not a snapshot). */
  state(): TuiState
  /** Host context the `session/event` listener subscribes through. */
  ctx: Context
  /** The rebindable agent holder (re-read live at fire time). */
  current: { handle: AgentHandle; agent: Agent }
  /** Fold the live plan/permission mode. */
  liveMode(agent: Agent, fallback?: string): string
  /** Tool presenters for folding replayed session events. */
  presenters: ToolPresenters | undefined
  /** Late-bound queue flush (wired after createQueueSection). */
  flushQueue(): void
  /** Transient user-visible notice (the classifier-breaker fallback hint). */
  showNotice(text: string): void
}

// re-export the event-like types so the agent section can type them without
// importing the (heavier) transcript module directly in its own ctx.
export type { SessionEventLike, ToolPresenters }
