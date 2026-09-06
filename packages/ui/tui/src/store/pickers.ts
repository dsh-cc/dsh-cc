/**
 * Overlay picker reducers (/model, /effort, /permissions, /resume): a shared
 * park-or-clear plus clamped focus/move pattern per picker overlay.
 * @module @dsh-cc/tui/store/pickers
 */
import { WORKTREE_EXIT_OPTION_COUNT } from './views.ts'
import type { EffortPickerView, ModelPickerView, PermissionPickerView, SessionSwitcherView, TuiState, WorktreeExitView } from './views.ts'

/** Park or clear the `/model` picker overlay. */
export function setModelPicker(state: TuiState, picker: ModelPickerView | undefined): TuiState {
  const { modelPicker: _dropped, ...rest } = state
  return picker === undefined ? rest : { ...rest, modelPicker: picker }
}

/** Focus a model-picker row by index, clamped to [0, entries.length-1]. */
export function focusModelPicker(state: TuiState, index: number): TuiState {
  const picker = state.modelPicker
  if (picker === undefined || picker.entries.length === 0) return state
  const max = picker.entries.length - 1
  const focused = Math.max(0, Math.min(index, max))
  return setModelPicker(state, { ...picker, focused })
}

/** Move the model-picker focus by one row (clamped; no wrap). */
export function moveModelPickerFocus(state: TuiState, delta: -1 | 1): TuiState {
  const picker = state.modelPicker
  if (picker === undefined) return state
  return focusModelPicker(state, picker.focused + delta)
}

/** Park or clear the `/effort` picker overlay. */
export function setEffortPicker(state: TuiState, picker: EffortPickerView | undefined): TuiState {
  const { effortPicker: _dropped, ...rest } = state
  return picker === undefined ? rest : { ...rest, effortPicker: picker }
}

/** Focus an effort-picker row by index, clamped to [0, entries.length-1]. */
export function focusEffortPicker(state: TuiState, index: number): TuiState {
  const picker = state.effortPicker
  if (picker === undefined || picker.entries.length === 0) return state
  const max = picker.entries.length - 1
  const focused = Math.max(0, Math.min(index, max))
  return setEffortPicker(state, { ...picker, focused })
}

/** Move the effort-picker focus by one row (clamped; no wrap). */
export function moveEffortPickerFocus(state: TuiState, delta: -1 | 1): TuiState {
  const picker = state.effortPicker
  if (picker === undefined) return state
  return focusEffortPicker(state, picker.focused + delta)
}

/** Park or clear the `/permissions` picker overlay. */
export function setPermissionPicker(state: TuiState, picker: PermissionPickerView | undefined): TuiState {
  const { permissionPicker: _dropped, ...rest } = state
  return picker === undefined ? rest : { ...rest, permissionPicker: picker }
}

/**
 * Focus a permission-picker row by index, clamped to [0, entries.length-1].
 * Always drops `confirmingBypass` so the risk-gate flag cannot stick to a
 * non-bypass row after the user moves.
 */
export function focusPermissionPicker(state: TuiState, index: number): TuiState {
  const picker = state.permissionPicker
  if (picker === undefined || picker.entries.length === 0) return state
  const max = picker.entries.length - 1
  const focused = Math.max(0, Math.min(index, max))
  if (focused === picker.focused && picker.confirmingBypass === undefined) return state
  const { confirmingBypass: _dropped, ...rest } = picker
  return setPermissionPicker(state, { ...rest, focused })
}

/** Move the permission-picker focus by one row (clamped; no wrap). */
export function movePermissionPickerFocus(state: TuiState, delta: -1 | 1): TuiState {
  const picker = state.permissionPicker
  if (picker === undefined) return state
  return focusPermissionPicker(state, picker.focused + delta)
}

/** Park or clear the `/resume` session-switcher overlay. */
export function setSessionSwitcher(state: TuiState, switcher: SessionSwitcherView | undefined): TuiState {
  const { sessionSwitcher: _dropped, ...rest } = state
  return switcher === undefined ? rest : { ...rest, sessionSwitcher: switcher }
}

/** Focus a session-switcher row by index, clamped to [0, sessions.length-1]. */
export function focusSessionSwitcher(state: TuiState, index: number): TuiState {
  const sw = state.sessionSwitcher
  if (sw === undefined || sw.sessions.length === 0) return state
  const max = sw.sessions.length - 1
  const focused = Math.max(0, Math.min(index, max))
  return setSessionSwitcher(state, { ...sw, focused })
}

/** Move the session-switcher focus by one row (clamped; no wrap). */
export function moveSessionSwitcherFocus(state: TuiState, delta: -1 | 1): TuiState {
  const sw = state.sessionSwitcher
  if (sw === undefined) return state
  return focusSessionSwitcher(state, sw.focused + delta)
}

/** Park or clear the `/quit` worktree-exit confirmation overlay. */
export function setWorktreeExit(state: TuiState, view: WorktreeExitView | undefined): TuiState {
  const { worktreeExit: _dropped, ...rest } = state
  return view === undefined ? rest : { ...rest, worktreeExit: view }
}

/** Move the worktree-exit focus by one row (clamped; no wrap). */
export function moveWorktreeExitFocus(state: TuiState, delta: -1 | 1): TuiState {
  const view = state.worktreeExit
  if (view === undefined) return state
  const focused = Math.max(0, Math.min(view.focused + delta, WORKTREE_EXIT_OPTION_COUNT - 1))
  return setWorktreeExit(state, { ...view, focused })
}
