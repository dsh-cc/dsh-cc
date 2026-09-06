/**
 * View-layer types for the TUI store: transcript rows, overlay/picker views,
 * and the aggregate TuiState. Pure types — no reducer logic lives here.
 * @module @dsh-cc/tui/store/views
 */
import type { FileDiff } from '../tool-card.ts'
import type { TurnAnchor } from '../working-line.ts'
import type { ProviderPanelState } from './provider-panel.ts'

export type TranscriptRow =
  | { kind: 'user'; text: string; seq?: number }
  | { kind: 'assistant'; text: string; seq?: number }
  | { kind: 'thinking'; text: string; seq?: number }
  | {
    kind: 'tool'
    callId: string
    name: string
    args: string
    title: string
    body?: string
    result?: string
    error?: boolean
    running: boolean
    /** Structured file diffs from a presenter's diff-card view; rendered as hunks. */
    diffs?: readonly FileDiff[]
    seq?: number
  }
  | {
    kind: 'banner'
    /** Pre-styled UI chrome (boot whale art); rendered verbatim, no theme wrap. */
    text: string
    /**
     * No `seq`: like the boot status row, the banner survives compaction.
     * Markdown export skips it entirely.
     */
    seq?: number
  }
  | {
    kind: 'status'
    text: string
    /**
     * Marks this status row as an error so the renderer paints it red instead
     * of dim. Set by `turn/end` error folding; plain status notices stay dim.
     */
    error?: boolean
    seq?: number
  }
  | {
    kind: 'compact'
    /** `'manual'` when a /compact command drove it, `'auto'` for pressure compaction. */
    trigger: 'manual' | 'auto'
    /** Shadowed history item count (from the compaction/summary metering). */
    items: number
    /** Heuristic tokens the compaction shadowed. */
    tokens: number
    /** Extracted `<compacted-summary>` body; '' when unavailable. */
    summary: string
    seq?: number
  }

/**
 * Structured payload preview attached to an approval prompt, recovered from
 * the paired tool/call event: the shell command, the affected file diffs, or
 * the pretty-printed raw arguments. `none` degrades to tool name + reason.
 */
export type ApprovalPreview =
  | { kind: 'command'; command: string }
  | { kind: 'diff'; diffs: readonly FileDiff[] }
  | { kind: 'args'; json: string }
  | { kind: 'none' }

export interface ApprovalView {
  toolName: string
  reason?: string
  /** Structured payload preview for the call under review. */
  preview?: ApprovalPreview
  /** Modal entries waiting behind this one in the approval queue; absent for a lone head. */
  pendingCount?: number
}

export interface QuestionOptionView {
  label: string
  description?: string
}

/**
 * Live view of an ask-user-question prompt: the full first question item
 * (text, detail markdown, option descriptions, multiSelect, intent) plus the
 * interaction state the overlay mutates as the user navigates.
 */
export interface QuestionView {
  header: string
  /** The item's question text. */
  question: string
  /** Supporting detail (plan markdown for plan-review intents). */
  detail?: string
  options: readonly QuestionOptionView[]
  /** Whether more than one option may be selected. */
  multiSelect: boolean
  intent?: { kind: 'plan-review'; approve: string }
  /**
   * Focused row: an index into `options`, or `options.length` for the
   * trailing free-text ("Other") row.
   */
  focused: number
  /** Toggled labels (multiSelect) — single-select resolves on pick. */
  selected: readonly string[]
  /** Free-text buffer for the "Other" row. */
  custom: string
}

/**
 * One LLM adapter entry shown in the `/model` picker. Mirrors the harness
 * {@link CatalogEntry} but lives in the view layer (harness-import-free).
 */
export interface CatalogEntryView {
  provider: string
  id: string
  name: string
}

/**
 * Live view of the `/model` picker overlay: the catalog rows, the focused
 * index, and the active model route (if any) so the renderer can mark it.
 */
export interface ModelPickerView {
  entries: readonly CatalogEntryView[]
  focused: number
  current?: { provider: string; model: string }
}

/**
 * Live view of the `/effort` picker overlay: the reasoning-effort levels of
 * the active model plus the trailing reserved entry (the literal
 * `'default'`), the focused index, and the current effort (if any) so the
 * renderer can mark it. Plain strings — branding to `ReasoningEffortId`
 * happens at the driver's write seam.
 */
export interface EffortPickerView {
  entries: readonly string[]
  focused: number
  current: string | undefined
}

/**
 * One row in the `/permissions` picker. Mirrors the command package's
 * permission-mode option (`id`/`label`/`detail`) but lives in the view
 * layer so the overlay can render without importing the host surface.
 */
export interface PermissionPickerEntryView {
  id: string
  label: string
  detail: string
}

/**
 * Live view of the `/permissions` picker overlay: the five CC rule-engine
 * modes, the focused index, the current mode (so the renderer can mark it),
 * and an optional in-overlay confirmation step for `bypassPermissions`.
 */
export interface PermissionPickerView {
  entries: readonly PermissionPickerEntryView[]
  focused: number
  current: string
  confirmingBypass?: true
}

/**
 * One session entry shown in the `/resume` picker. Mirrors the harness
 * persistence header but lives in the view layer (harness-import-free).
 */
export interface SessionEntryView {
  id: string
  cwd?: string
  createdAt: number
  /** Last-activity mtime from persistence when the backend can observe it. */
  updatedAtMs?: number
  /** Async-decorated session title; absent until the title read lands. */
  title?: string
  /** Parent session id when this entry is a fork/child. */
  parentSession?: string
}

/**
 * Live view of the `/resume` session-switcher overlay: the filtered,
 * last-active-first session list, the focused index, a `switching` flag that
 * dims input while a switch is in flight, the current session id (marked
 * with `●`), the typed query filter, and the visibility scope. `sessions` is
 * the visible list only — the full list stays in the driver and
 * `totalCount` carries its length for the empty-cwd-scope hint.
 */
export interface SessionSwitcherView {
  sessions: readonly SessionEntryView[]
  focused: number
  switching: boolean
  currentId: string
  /** Free-text filter typed inside the picker ('' when none). */
  query: string
  /** Visibility scope: this project's cwd (default) or every project. */
  scope: 'cwd' | 'all'
  /**
   * The cwd the project scope was derived from. Rows whose recorded cwd
   * differs (worktree / subdirectory sessions of the same project) surface
   * their cwd basename even in cwd scope.
   */
  cwd?: string
  /** Length of the unfiltered list, for the "Tab to view all (N)" hint. */
  totalCount?: number
}

/**
 * One observed subagent run. `subagent/start` and `subagent/end` are global
 * (process-scoped) observe-only snapshots paired by `runId`; the driver
 * folds them into this view without calling `listChildren` — tracking is
 * event-only, so it stays composition-agnostic.
 */
export interface SubagentRunView {
  runId: string
  provider: string
  sessionId: string
  /**
   * Continuable (resumable) epochs park on `subagent/end` — the activation is
   * torn down but the session lives; one-shot runs end as `done`.
   */
  status: 'running' | 'parked' | 'done'
  /** Present once the `subagent/end` snapshot lands. */
  stopReason?: string
  /**
   * True when the child session carries a continuable descriptor, so a later
   * `subagent/start` for the same `sessionId` is a cold-resume of this row.
   */
  resumable?: boolean
}

/**
 * Live statusline HUD fed by the sessionProjections change feed:
 * context-occupancy percent and cumulative token totals. Both fields are
 * optional — the footer omits whatever the current composition lacks.
 */
export interface HudView {
  /** Context occupancy, 0-100 integer; absent until a window is known. */
  contextPercent?: number
  /** Cumulative provider-reported token totals. */
  tokens?: { input: number; output: number }
  /**
   * Raw occupancy behind `contextPercent` for exact rendering. The numerator
   * is the projected token count — never back-derived from the rounded
   * percent. `window` is absent when the projection does not report one.
   */
  contextTokens?: { readonly used: number; readonly window?: number }
}

/**
 * One todo from the session's todo list. Mirrors the harness projection's
 * item shape but lives in the view layer (harness-import-free).
 */
export interface TodoItemView {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * Live view of the Ctrl+T todo panel overlay: only the interaction state the
 * panel mutates (the focused row index); the rows come from `state.todos`.
 */
export interface TodoPanelView {
  focused: number
}

/** Cumulative token usage across the four provider-reported buckets. */
export interface UsageTotalsView {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/** Context composition by role: system prompt, tool output, messages. */
export interface UsageBreakdownView {
  system: number
  tools: number
  messages: number
}

/**
 * Live `/usage` panel content, folded from the tokenUsage, contextPressure,
 * and contextBreakdown projections. Every section is optional — the panel
 * degrades each missing one to a dim `n/a` independently.
 */
export interface UsageView {
  totals?: UsageTotalsView
  /** Context tokens currently projected into the window. */
  contextUsed?: number
  /** Context window size; absent when the projection does not report one. */
  contextWindow?: number
  breakdown?: UsageBreakdownView
}

/**
 * Marker for the open `/usage` panel overlay — pure display with no focus or
 * navigation state; the content comes from `state.usage`.
 */
export type UsagePanelView = Record<string, never>

/**
 * Live view of the `/quit` worktree-exit confirmation overlay: the session
 * descriptor under decision, the removal evidence shown next to the
 * destructive option, and the focused row (`0` keep, `1` remove, `2`
 * cancel). `busy` marks an in-flight removal — keys stay swallowed.
 * Plain fields only: the store must not import from harness/.
 */
export interface WorktreeExitView {
  /** Canonical repository root (where `.claude/worktrees` lives). */
  repoRoot: string
  /** Absolute worktree path (the session cwd). */
  worktreePath: string
  /** The branch checked out in the worktree. */
  branch: string
  /** True when created via the launcher's `--worktree` (branch is owned). */
  managed: boolean
  /** Whether removal may also delete the backing branch. */
  ownsBranch: boolean
  /** Managed sessions only: the commit the worktree was created from. */
  baseHead?: string
  /** Uncommitted changes; undefined when the probe failed. */
  dirtyFiles?: number
  /** Managed sessions only: commits past baseHead; undefined when unknown. */
  commitsAhead?: number
  /** Focused option row: 0 keep, 1 remove, 2 cancel. */
  focused: number
  /** Removal in flight. */
  busy: boolean
}

/** Number of rows in the worktree-exit overlay (keep / remove / cancel). */
export const WORKTREE_EXIT_OPTION_COUNT = 3

/**
 * Live view of the `/provider` overlay home (§4.2): the two-section list
 * rows, the focused cursor, and a transient message line. Reuses the pure
 * panel state directly — the list phase is the only phase this unit wires.
 */
export type ProviderPanelView = ProviderPanelState

export interface TuiState {
  rows: TranscriptRow[]
  draft: string
  busy: boolean
  /**
   * Anchor of the currently-running turn (drives the working line): absent
   * while idle. `busy` alone cannot back the line — it flips false on the
   * first assistant/message fold and jitters within a turn.
   */
  turn?: TurnAnchor
  permissionMode: string
  notice?: string
  approval?: ApprovalView
  question?: QuestionView
  modelPicker?: ModelPickerView
  /** Open `/effort` picker overlay; absent while closed. */
  effortPicker?: EffortPickerView
  /** Open `/permissions` picker overlay; absent while closed. */
  permissionPicker?: PermissionPickerView
  sessionSwitcher?: SessionSwitcherView
  /**
   * Outbox of texts submitted while the agent was busy: rendered as pending
   * chips, flushed into the next turn on durable `turn/end` (or injected
   * immediately via Ctrl+S). Idle submits bypass the outbox entirely.
   */
  queued: readonly string[]
  /** Whether thinking rows render expanded (Ctrl+O). Collapsed by default. */
  thinkingExpanded: boolean
  /**
   * Whether tool rows render their output (body/result/diffs) expanded
   * (Ctrl+O). Expanded by default — collapsing is opt-in via the toggle.
   */
  toolOutputExpanded: boolean
  /** Whether compact rows render their summary body (Ctrl+O). Collapsed by default. */
  compactExpanded: boolean
  /**
   * Metering carried from the `compaction/summary` event to the immediately
   * following surface replacement, so the compact row can show how much the
   * checkpoint shadowed. Cleared when a replace consumes it.
   */
  pendingCompact?: { items: number; tokens: number; sourceCommandId?: string }
  /** Observed subagent runs (newest appended; capped at 20). */
  subagents: readonly SubagentRunView[]
  /** Statusline HUD (context %, token totals) from the projections feed. */
  hud?: HudView
  /** Session todo list (whole-list last-wins; absent before the first write). */
  todos?: readonly TodoItemView[]
  /** Open Ctrl+T todo panel; absent while closed. */
  todoPanel?: TodoPanelView
  /** Live usage snapshot (token totals, context occupancy, breakdown). */
  usage?: UsageView
  /** Open `/usage` panel; absent while closed. */
  usagePanel?: UsagePanelView
  /** Open `/quit` worktree-exit confirmation overlay; absent while closed. */
  worktreeExit?: WorktreeExitView
  /** Open `/provider` panel; absent while closed. */
  providerPanel?: ProviderPanelView
  /**
   * Latest `session/title` event text (framework-generated session summary),
   * folded last-wins. Drives the terminal window title; absent until the
   * first title lands. Log-only: never produces a transcript row.
   */
  title?: string
  /**
   * Timestamp (`Date.now()`) of the last idle Ctrl+C press — the anchor for
   * the double-press-to-exit window. Never cleared: a stale anchor simply
   * falls outside the window, so the next press starts a new attempt.
   */
  lastExitAttemptAt?: number
}
