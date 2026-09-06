/**
 * In-memory TUI view model. Session events fold into rows here; nothing
 * is written back to the durable log.
 *
 * Implementation lives in the store/ domain modules; this file is the
 * public barrel — import from here, never from store/* internals.
 * @module @dsh-cc/tui/store
 */
export type {
  ApprovalPreview,
  ApprovalView,
  CatalogEntryView,
  EffortPickerView,
  HudView,
  ModelPickerView,
  PermissionPickerEntryView,
  PermissionPickerView,
  ProviderPanelView,
  QuestionOptionView,
  QuestionView,
  SessionEntryView,
  SessionSwitcherView,
  SubagentRunView,
  TodoItemView,
  TodoPanelView,
  TranscriptRow,
  TuiState,
  UsageBreakdownView,
  UsagePanelView,
  UsageTotalsView,
  UsageView,
  WorktreeExitView,
} from './store/views.ts'
export { WORKTREE_EXIT_OPTION_COUNT } from './store/views.ts'
export {
  clearRows,
  clearTurn,
  createInitialState,
  markExitAttempt,
  resetTurnStep,
  setApproval,
  setBusy,
  setDraft,
  setHud,
  setNotice,
  setPermissionMode,
  setSessionTitle,
  setTurnActive,
  toggleGlobalCollapse,
  toggleThinking,
  upsertRow,
} from './store/session.ts'
export {
  focusEffortPicker,
  focusModelPicker,
  focusPermissionPicker,
  focusSessionSwitcher,
  moveEffortPickerFocus,
  moveModelPickerFocus,
  movePermissionPickerFocus,
  moveSessionSwitcherFocus,
  moveWorktreeExitFocus,
  setEffortPicker,
  setModelPicker,
  setPermissionPicker,
  setSessionSwitcher,
  setWorktreeExit,
} from './store/pickers.ts'
export {
  backspaceQuestionText,
  focusQuestionOption,
  moveQuestionFocus,
  setQuestion,
  toggleQuestionOption,
  typeQuestionText,
} from './store/question.ts'
export { clearQueue, dequeue, enqueue, popQueued } from './store/queue.ts'
export { countRunningSubagents, upsertSubagent } from './store/subagents.ts'
export {
  closeTodoPanel,
  moveTodoPanelFocus,
  openTodoPanel,
  setTodoPanel,
  setTodos,
  todoSummary,
} from './store/todos.ts'
export {
  moveCursor,
  openProviderPanel,
  setProviderOverlay,
} from './store/provider-panel.ts'
export { closeUsagePanel, openUsagePanel, setUsage } from './store/usage.ts'
