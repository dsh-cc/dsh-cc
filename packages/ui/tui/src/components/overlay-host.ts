/**
 * Shared overlay host: single place that (a) routes one raw keypress into
 * whichever modal overlay is parked in the live state, and (b) rebuilds the
 * overlay slot's child boxes from the state on every driver emit. root.ts
 * calls these two helpers so adding an overlay kind never touches the mount.
 * @module @dsh-cc/tui/components/overlay-host
 */
import { Container } from '@dsh-cc/pi-tui'
import type { Driver } from '../state/driver-types.ts'
import { routeApprovalInput, routeQuestionInput, routeEffortPickerInput, routeModelPickerInput, routePermissionPickerInput, routeSessionSwitcherInput, routeTodoPanelInput, routeUsagePanelInput, routeWorktreeExitInput, routeProviderPanelInput } from '../input.ts'
import type { TuiState } from '../store.ts'
import {
  createApprovalBox,
  createEffortPickerBox,
  createModelPickerBox,
  createPermissionPickerBox,
  createQuestionBox,
  createSessionSwitcherBox,
  createTodoPanelBox,
  createUsagePanelBox,
  createWorktreeExitBox,
} from './overlays.ts'
import { createProviderPanelBox } from './provider-box.ts'
import type { Theme } from './theme.ts'

/** The `/provider` runtime seam the driver attaches (see harness/driver.ts). */
type ProviderRuntimeLike = Parameters<typeof routeProviderPanelInput>[0]

/**
 * Whether any modal overlay is open. Used by root's Ctrl+C branch: while an
 * overlay is open and the agent is idle, Ctrl+C falls through so the
 * overlay's own key handling (esc to dismiss, etc.) owns it.
 */
export function overlayOpen(state: TuiState): boolean {
  return state.approval !== undefined || state.question !== undefined ||
    state.modelPicker !== undefined || state.effortPicker !== undefined ||
    state.permissionPicker !== undefined ||
    state.sessionSwitcher !== undefined ||
    state.todoPanel !== undefined || state.usagePanel !== undefined ||
    state.worktreeExit !== undefined || state.providerPanel !== undefined
}

/**
 * Route one raw keypress into the open overlay. Order is fixed priority:
 * the first overlay kind parked in state owns the key. Returns true when an
 * overlay consumed the key (root must swallow it before the editor);
 * false means no overlay is open and other handlers proceed.
 */
export function routeOverlayInput(driver: Driver, live: TuiState, data: string): boolean {
  if (live.approval !== undefined) {
    // Approval keys route through the shared router in input.ts — the same
    // single source of truth the headless composer path uses.
    routeApprovalInput(driver, data)
    return true
  }
  if (live.question !== undefined) {
    // While a question is open every key belongs to the overlay — routed and
    // consumed here so the editor never sees typing, arrows, or enter.
    routeQuestionInput(driver, data)
    return true
  }
  if (live.modelPicker !== undefined) {
    // Modal model picker: arrows/enter/esc only, everything else consumed.
    routeModelPickerInput(driver, data)
    return true
  }
  if (live.effortPicker !== undefined) {
    // Modal effort picker: arrows/enter/esc only, everything else consumed.
    routeEffortPickerInput(driver, data)
    return true
  }
  if (live.permissionPicker !== undefined) {
    // Modal permission picker: arrows/enter/esc only, everything else consumed.
    routePermissionPickerInput(driver, data)
    return true
  }
  if (live.sessionSwitcher !== undefined) {
    // Modal session switcher: arrows/enter/esc only, everything else
    // consumed. While `switching` is true, all keys are consumed without
    // action.
    routeSessionSwitcherInput(driver, data)
    return true
  }
  if (live.todoPanel !== undefined) {
    // Modal todo panel: arrows/esc/ctrl+t (close) only, everything else
    // consumed. The open path is the ctrl+t binding in root, which only
    // fires while the panel is closed.
    routeTodoPanelInput(driver, data)
    return true
  }
  if (live.usagePanel !== undefined) {
    // Modal usage panel: pure display with no navigation — esc closes,
    // everything else is consumed. The open path is the /usage command.
    routeUsagePanelInput(driver, data)
    return true
  }
  if (live.worktreeExit !== undefined) {
    // Modal /quit worktree-exit confirmation: arrows/enter/esc only,
    // everything else consumed. While `busy` (a removal in flight) all
    // keys are swallowed by the router.
    routeWorktreeExitInput(driver, data)
    return true
  }
  if (live.providerPanel !== undefined) {
    // Modal `/provider` panel (§4.2–§4.6): phase-dependent routing through
    // the runtime seam the driver exposes (list j/k, wizard text entry,
    // detail actions, remove confirm).
    routeProviderPanelInput((driver as Driver & { providerRuntime?: ProviderRuntimeLike }).providerRuntime, data)
    return true
  }
  return false
}

/**
 * Rebuild the overlay slot's children from the current state: one box for
 * whichever overlay is parked, none when all are closed. Clears and
 * invalidates the container so boxes appear and disappear with the state.
 */
export function renderOverlayChildren(overlays: Container, state: TuiState, theme: Theme): void {
  overlays.clear()
  if (state.approval !== undefined) {
    overlays.addChild(createApprovalBox(state.approval, theme))
  }
  if (state.question !== undefined) {
    overlays.addChild(createQuestionBox(state.question, theme))
  }
  if (state.modelPicker !== undefined) {
    overlays.addChild(createModelPickerBox(state.modelPicker, theme))
  }
  if (state.effortPicker !== undefined) {
    overlays.addChild(createEffortPickerBox(state.effortPicker, theme))
  }
  if (state.permissionPicker !== undefined) {
    overlays.addChild(createPermissionPickerBox(state.permissionPicker, theme))
  }
  if (state.sessionSwitcher !== undefined) {
    overlays.addChild(createSessionSwitcherBox(state.sessionSwitcher, theme))
  }
  if (state.todoPanel !== undefined) {
    overlays.addChild(createTodoPanelBox(state.todos ?? [], state.todoPanel.focused, theme))
  }
  if (state.usagePanel !== undefined) {
    // The panel rebuilds from the live snapshot on every emit, so
    // projection changes refresh it in place while it is open.
    overlays.addChild(createUsagePanelBox(state.usage, theme))
  }
  if (state.worktreeExit !== undefined) {
    overlays.addChild(createWorktreeExitBox(state.worktreeExit, theme))
  }
  if (state.providerPanel !== undefined) {
    overlays.addChild(createProviderPanelBox(state.providerPanel, theme))
  }
  overlays.invalidate()
}
