/**
 * Global composer key handling. The editor owns typing, backspace, and enter;
 * this module handles only overlay answers, permission cycling, interrupt,
 * and quit. Reads the live driver snapshot so keystrokes never land on a
 * stale closure.
 * @module @dsh-cc/tui/input
 */

import { Key, decodeKittyPrintable, matchesKey } from '@dsh-cc/pi-tui'
import type { ApprovalAnswerKind } from './state/driver-types.ts'
import type { TuiState } from './store.ts'

export interface InputSink {
  state: TuiState
  interrupt(): void
  cyclePermissionMode(): void
  toggleThinking(): void
  answerApproval(kind: ApprovalAnswerKind): void
  questionMove(delta: -1 | 1): void
  questionToggle(): void
  questionPick(index: number): void
  questionType(text: string): void
  questionBackspace(): void
  questionSubmit(): void
  questionCancel(): void
  modelPickerMove(delta: -1 | 1): void
  modelPickerSubmit(): void
  modelPickerCancel(): void
  effortPickerMove(delta: -1 | 1): void
  effortPickerSubmit(): void
  effortPickerCancel(): void
  permissionPickerMove(delta: -1 | 1): void
  permissionPickerSubmit(): void
  permissionPickerCancel(): void
  sessionSwitcherMove(delta: -1 | 1): void
  sessionSwitcherType(text: string): void
  sessionSwitcherBackspace(): void
  sessionSwitcherToggleScope(): void
  sessionSwitcherSubmit(): Promise<void>
  sessionSwitcherCancel(): void
  /** Toggle the Ctrl+T todo panel: close it when open, open it when closed. */
  toggleTodoPanel(): void
  /** Move the todo-panel focus by one row (clamped; no wrap). */
  todoPanelMove(delta: -1 | 1): void
  /** Close the todo panel. */
  todoPanelClose(): void
  /** Close the `/usage` panel. */
  usagePanelClose(): void
  /** Move the `/quit` worktree-exit focus by one row. */
  worktreeExitMove(delta: -1 | 1): void
  /** Confirm the focused worktree-exit option. */
  worktreeExitSubmit(): Promise<void>
  /** Dismiss the `/quit` worktree-exit overlay without quitting. */
  worktreeExitCancel(): void
  dispose(): Promise<void>
}

export type InputAction =
  | { kind: 'none' }
  | { kind: 'quit' }

/**
 * Decode a raw keypress into the printable character it types, if any. Kitty
 * CSI-u / modifyOtherKeys sequences decode via the vendored helper; legacy
 * input arrives as the character itself.
 */
function printableOf(data: string): string | undefined {
  const decoded = decodeKittyPrintable(data)
  if (decoded !== undefined) return decoded
  if (data.length === 1) {
    const code = data.charCodeAt(0)
    if (code >= 32 && code !== 127) return data
  }
  return undefined
}

/**
 * Route one raw keypress into the open approval overlay: `1`/`y`/`Y` grant
 * once, `2`/`n`/`N`/escape reject, `3`/`a`/`A` grant always (once + persist a
 * derived allow rule), `4`/`s`/`S` grant for this session (once + a
 * session-scoped allowlist rule, never persisted to global settings). Every
 * other key is consumed and ignored — the overlay
 * is modal and the composer editor must never see keystrokes while it is open.
 * Shared by the headless composer path and the mounted root listener so the
 * key map has a single source of truth.
 */
export function routeApprovalInput(driver: InputSink, data: string): void {
  if (matchesKey(data, '1') || data === 'y' || data === 'Y') {
    driver.answerApproval('once')
    return
  }
  if (matchesKey(data, '2') || data === 'n' || data === 'N' || matchesKey(data, Key.escape)) {
    driver.answerApproval('reject')
    return
  }
  if (matchesKey(data, '3') || data === 'a' || data === 'A') {
    driver.answerApproval('always')
    return
  }
  if (matchesKey(data, '4') || data === 's' || data === 'S') {
    driver.answerApproval('session')
    return
  }
  // All other keys consumed and ignored (modal).
}

/**
 * Route one raw keypress into the open question overlay. Every recognized
 * key is handled and every other input is dropped — the composer editor must
 * never see keystrokes while a question is open.
 */
export function routeQuestionInput(driver: InputSink, data: string): void {
  if (matchesKey(data, Key.escape)) {
    driver.questionCancel()
    return
  }
  if (matchesKey(data, Key.up)) {
    driver.questionMove(-1)
    return
  }
  if (matchesKey(data, Key.down)) {
    driver.questionMove(1)
    return
  }
  if (matchesKey(data, Key.enter)) {
    driver.questionSubmit()
    return
  }
  if (matchesKey(data, Key.backspace)) {
    driver.questionBackspace()
    return
  }
  if (matchesKey(data, Key.space)) {
    driver.questionToggle()
    return
  }
  if (data.length === 1 && data >= '1' && data <= '9') {
    // Digit quick-pick: the driver bounds-checks against the option list.
    driver.questionPick(Number.parseInt(data, 10) - 1)
    return
  }
  const printable = printableOf(data)
  if (printable !== undefined) driver.questionType(printable)
}

/**
 * Route one raw keypress into the open model picker. Only arrows, enter, and
 * escape are recognized; everything else is dropped — the picker is modal and
 * the composer editor must never see keystrokes while it is open.
 */
export function routeModelPickerInput(driver: InputSink, data: string): void {
  if (matchesKey(data, Key.escape)) {
    driver.modelPickerCancel()
    return
  }
  if (matchesKey(data, Key.up)) {
    driver.modelPickerMove(-1)
    return
  }
  if (matchesKey(data, Key.down)) {
    driver.modelPickerMove(1)
    return
  }
  if (matchesKey(data, Key.enter)) {
    driver.modelPickerSubmit()
    return
  }
  // All other keys are consumed and ignored (modal).
}

/**
 * Route one raw keypress into the open effort picker. Only arrows, enter, and
 * escape are recognized; everything else is dropped — the picker is modal and
 * the composer editor must never see keystrokes while it is open.
 */
export function routeEffortPickerInput(driver: InputSink, data: string): void {
  if (matchesKey(data, Key.escape)) {
    driver.effortPickerCancel()
    return
  }
  if (matchesKey(data, Key.up)) {
    driver.effortPickerMove(-1)
    return
  }
  if (matchesKey(data, Key.down)) {
    driver.effortPickerMove(1)
    return
  }
  if (matchesKey(data, Key.enter)) {
    driver.effortPickerSubmit()
    return
  }
  // All other keys are consumed and ignored (modal).
}

/**
 * Route one raw keypress into the open `/quit` worktree-exit confirmation.
 * Only arrows, enter, and escape are recognized; everything else is dropped
 * — the overlay is modal and the composer editor must never see keystrokes
 * while it is open. Enter on the focused row (keep/remove/cancel) is
 * adjudicated by the driver.
 */
export function routeWorktreeExitInput(driver: InputSink, data: string): void {
  if (matchesKey(data, Key.escape)) {
    driver.worktreeExitCancel()
    return
  }
  if (matchesKey(data, Key.up)) {
    driver.worktreeExitMove(-1)
    return
  }
  if (matchesKey(data, Key.down)) {
    driver.worktreeExitMove(1)
    return
  }
  if (matchesKey(data, Key.enter)) {
    void driver.worktreeExitSubmit()
    return
  }
  // All other keys are consumed and ignored (modal).
}

/**
 * Route one raw keypress into the open permission picker. Only arrows, enter,
 * and escape are recognized; everything else is dropped — the picker is modal
 * and the composer editor must never see keystrokes while it is open.
 */
export function routePermissionPickerInput(driver: InputSink, data: string): void {
  if (matchesKey(data, Key.escape)) {
    driver.permissionPickerCancel()
    return
  }
  if (matchesKey(data, Key.up)) {
    driver.permissionPickerMove(-1)
    return
  }
  if (matchesKey(data, Key.down)) {
    driver.permissionPickerMove(1)
    return
  }
  if (matchesKey(data, Key.enter)) {
    driver.permissionPickerSubmit()
    return
  }
  // All other keys are consumed and ignored (modal).
}

/**
 * Route one raw keypress into the open session switcher: arrows move, enter
 * switches, tab toggles the cwd/all-projects scope, backspace and printable
 * characters edit the query filter, and escape cancels (the two-stage
 * clear-filter-then-close lives in the driver). Everything else is dropped —
 * the switcher is modal and the composer editor must never see keystrokes
 * while it is open. While `switching` is true, every key is consumed without
 * action.
 */
export function routeSessionSwitcherInput(driver: InputSink, data: string): void {
  if (driver.state.sessionSwitcher?.switching === true) return
  if (matchesKey(data, Key.escape)) {
    driver.sessionSwitcherCancel()
    return
  }
  if (matchesKey(data, Key.tab)) {
    driver.sessionSwitcherToggleScope()
    return
  }
  if (matchesKey(data, Key.up)) {
    driver.sessionSwitcherMove(-1)
    return
  }
  if (matchesKey(data, Key.down)) {
    driver.sessionSwitcherMove(1)
    return
  }
  if (matchesKey(data, Key.enter)) {
    void driver.sessionSwitcherSubmit()
    return
  }
  if (matchesKey(data, Key.backspace)) {
    driver.sessionSwitcherBackspace()
    return
  }
  const printable = printableOf(data)
  if (printable !== undefined) driver.sessionSwitcherType(printable)
}

/**
 * Route one raw keypress into the open todo panel. Only arrows, escape, and
 * ctrl+t (toggle closed) are recognized; everything else is dropped — the
 * panel is modal and the composer editor must never see keystrokes while it
 * is open. Opening is owned by the ctrl+t binding in the global listener,
 * which only fires while the panel is closed.
 */
export function routeTodoPanelInput(driver: InputSink, data: string): void {
  if (matchesKey(data, Key.ctrl('t'))) {
    driver.todoPanelClose()
    return
  }
  if (matchesKey(data, Key.escape)) {
    driver.todoPanelClose()
    return
  }
  if (matchesKey(data, Key.up)) {
    driver.todoPanelMove(-1)
    return
  }
  if (matchesKey(data, Key.down)) {
    driver.todoPanelMove(1)
    return
  }
  // All other keys consumed and ignored (modal).
}

/**
 * Route one raw keypress into the open `/usage` panel. The panel is pure
 * display with no focus list, so escape closes it and every other key is
 * consumed and ignored — the composer editor must never see keystrokes while
 * it is open. Opening is owned by the `/usage` command.
 */
export function routeUsagePanelInput(driver: InputSink, data: string): void {
  if (matchesKey(data, Key.escape)) {
    driver.usagePanelClose()
    return
  }
  // All other keys consumed and ignored (modal, no navigation).
}

/**
 * Route one raw keypress into the open `/provider` panel (§4.2–§4.6).
 * Phase-dependent: the list phase keeps j/k navigation (+ `n` starts the
 * custom wizard); the wizard phase feeds printable keys/backspace into the
 * live text field, arrows move the protocol select, enter submits, tab runs
 * the models fetch, `x` is the secondary choice (keep/remove, keep
 * credential), and esc backs one step (closing with a note at the first
 * step). Every other key is consumed — the panel is modal and the composer
 * editor must never see keystrokes while it is open.
 */
type ProviderPanelRouter = {
  panelPhase?(): 'list' | 'detail' | 'wizard' | 'confirm-remove' | undefined
  panelMove(delta: -1 | 1): void
  panelSubmit(): void
  panelCancel(): void
  panelEscape?(): void
  panelType?(text: string): void
  panelBackspace?(): void
  panelToggleFetch?(): void
  panelSecondary?(): void
  panelRefreshModels?(): void
  startCustomWizard?(): void
}

export function routeProviderPanelInput(runtime: ProviderPanelRouter | undefined, data: string): void {
  if (runtime === undefined) return
  const phase = runtime.panelPhase?.() ?? 'list'
  if (matchesKey(data, Key.escape)) {
    if (runtime.panelEscape !== undefined) runtime.panelEscape()
    else runtime.panelCancel()
    return
  }
  if (matchesKey(data, Key.enter)) {
    runtime.panelSubmit()
    return
  }
  if (phase === 'wizard') {
    if (matchesKey(data, Key.tab)) {
      runtime.panelToggleFetch?.()
      return
    }
    if (data === 'x') {
      runtime.panelSecondary?.()
      return
    }
  }
  if (matchesKey(data, Key.up)) {
    runtime.panelMove(-1)
    return
  }
  if (matchesKey(data, Key.down)) {
    runtime.panelMove(1)
    return
  }
  if (phase === 'detail') {
    if (data === 'r') {
      runtime.panelRefreshModels?.()
      return
    }
  }
  if (phase === 'list') {
    if (data === 'n') {
      runtime.startCustomWizard?.()
      return
    }
    if (data === 'j') {
      runtime.panelMove(1)
      return
    }
    if (data === 'k') {
      runtime.panelMove(-1)
      return
    }
  }
  if (matchesKey(data, Key.backspace)) {
    runtime.panelBackspace?.()
    return
  }
  if (phase === 'wizard') {
    const printable = printableOf(data)
    if (printable !== undefined) runtime.panelType?.(printable)
  }
  // All other keys consumed (modal).
}

/**
 * Apply one raw keypress against the live driver. Returns whether the app
 * should exit. Called from the pi-tui global input listener before the editor
 * receives the keystroke.
 */
export function handleComposerInput(driver: InputSink, data: string): InputAction {
  const live = driver.state

  if (live.approval !== undefined) {
    routeApprovalInput(driver, data)
    return { kind: 'none' }
  }

  if (live.question !== undefined) {
    routeQuestionInput(driver, data)
    return { kind: 'none' }
  }

  if (live.modelPicker !== undefined) {
    routeModelPickerInput(driver, data)
    return { kind: 'none' }
  }

  if (live.effortPicker !== undefined) {
    routeEffortPickerInput(driver, data)
    return { kind: 'none' }
  }

  if (live.permissionPicker !== undefined) {
    routePermissionPickerInput(driver, data)
    return { kind: 'none' }
  }

  if (live.sessionSwitcher !== undefined) {
    routeSessionSwitcherInput(driver, data)
    return { kind: 'none' }
  }

  if (live.todoPanel !== undefined) {
    routeTodoPanelInput(driver, data)
    return { kind: 'none' }
  }

  if (live.usagePanel !== undefined) {
    routeUsagePanelInput(driver, data)
    return { kind: 'none' }
  }

  if (live.worktreeExit !== undefined) {
    routeWorktreeExitInput(driver, data)
    return { kind: 'none' }
  }

  if (matchesKey(data, 'shift+tab')) {
    driver.cyclePermissionMode()
    return { kind: 'none' }
  }

  if (matchesKey(data, Key.ctrl('o'))) {
    driver.toggleThinking()
    return { kind: 'none' }
  }

  if (matchesKey(data, Key.ctrl('t'))) {
    driver.toggleTodoPanel()
    return { kind: 'none' }
  }

  if (matchesKey(data, Key.escape)) {
    if (live.busy) driver.interrupt()
    return { kind: 'none' }
  }

  if (matchesKey(data, Key.ctrl('c'))) {
    void driver.dispose()
    return { kind: 'quit' }
  }

  return { kind: 'none' }
}
