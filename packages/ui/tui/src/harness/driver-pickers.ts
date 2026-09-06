/**
 * Model / effort / permission pickers for the in-process driver. Verbatim
 * extraction from harness/driver.ts (openModelPicker / applyModelSwitch /
 * openEffortPicker / openPermissionPicker plus the return-literal picker
 * bodies), reading shared state through a DriverPickersCtx instead of
 * createDriver's closures.
 *
 * The pickers are stateless overlays: each open parks picker state and each
 * submit reads-then-closes before validating. The bare model switch writes
 * synchronously; a carried effort validates detached via resolveEfforts /
 * stalePair, kept in createDriver and passed in.
 * @module @dsh-cc/tui/harness/driver-pickers
 */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { BYPASS_MODE, PERMISSION_MODE_OPTIONS } from '@dsh-cc/command-permissions'
import {
  moveEffortPickerFocus,
  moveModelPickerFocus,
  movePermissionPickerFocus,
  setEffortPicker,
  setModelPicker,
  setPermissionPicker,
  upsertRow,
  type CatalogEntryView,
  type TuiState,
} from '../store.ts'
import { formatModelCatalog, type CatalogEntry } from '../model-catalog.ts'
import type { DriverPickersCtx } from './driver-ctx.ts'

/** A single selection route, matching what selection.current holds. */
type SelectionRoute = { provider: string; model: string; reasoningEffort?: string }

/**
 * Free-function collaborator implementing the three pickers. Reads all shared
 * state/functions off `rt` (DriverPickersCtx) so it never imports the
 * createDriver factory. `selection` is passed by reference so writes land on
 * createDriver's live ref across switchSession; resolveEfforts / stalePair /
 * loadCatalog stay in createDriver and arrive on the ctx.
 */
export function createPickersSection(rt: DriverPickersCtx): {
  openModelPicker(): Promise<void>
  applyModelSwitch(provider: string, model: string): Promise<void>
  openEffortPicker(): Promise<void>
  openPermissionPicker(): void
  modelPickerMove(delta: -1 | 1): void
  modelPickerSubmit(): Promise<void>
  modelPickerCancel(): void
  effortPickerMove(delta: -1 | 1): void
  effortPickerSubmit(): Promise<void>
  effortPickerCancel(): void
  permissionPickerMove(delta: -1 | 1): void
  permissionPickerSubmit(): Promise<void>
  permissionPickerCancel(): void
  loadModelCatalog(): Promise<CatalogEntry[]>
  loadModelEfforts(): Promise<string[]>
} {
  // `/model` (no args) opens a modal picker instead of dumping a text catalog.
  // The arg path (`/model <n|provider/id>`) stays text-based for scripts.
  const openModelPicker = async (): Promise<void> => {
    const catalog = await rt.loadCatalog()
    const currentRoute = rt.selection.current === undefined
      ? undefined
      : { provider: rt.selection.current.provider, model: rt.selection.current.model }
    if (catalog.length === 0) {
      rt.emit(upsertRow(rt.state(), { kind: 'status', text: formatModelCatalog(catalog, currentRoute) }))
      return
    }
    const entries: CatalogEntryView[] = catalog.map(entry => ({
      provider: entry.provider,
      id: entry.id,
      name: entry.name,
    }))
    let focused = 0
    if (currentRoute !== undefined) {
      const index = entries.findIndex(
        entry => entry.provider === currentRoute.provider && entry.id === currentRoute.model,
      )
      if (index >= 0) focused = index
    }
    rt.emit(setModelPicker(rt.state(), {
      entries,
      focused,
      ...currentRoute === undefined ? {} : { current: currentRoute },
    }))
  }

  /**
   * Apply a `/model` switch to `provider`/`model`, carrying the live effort
   * when the new model still supports it. The bare pair needs no validation,
   * so the no-carried-effort path writes synchronously in the caller's tick;
   * the carried path validates via rt.resolveEfforts and degrades to a
   * bare pair + reset notice when the effort is unsupported OR unresolvable —
   * the switch itself never fails on validation. The stale-pair guard covers
   * the detached continuation: a selection that moved while validation was in
   * flight is never clobbered.
   */
  const applyModelSwitch = async (provider: string, model: string): Promise<void> => {
    const captured = rt.selection.current
    const carried = captured?.reasoningEffort
    if (captured === undefined || carried === undefined) {
      rt.selection.current = { provider, model }
      rt.emit(upsertRow(rt.state(), { kind: 'status', text: `Model is now ${provider}/${model}.` }))
      return
    }
    const efforts = await rt.resolveEfforts(provider, model)
    if (rt.stalePair(captured)) return
    const supported = efforts?.some(level => level.id === carried) === true
    rt.selection.current = supported
      ? { provider, model, reasoningEffort: ReasoningEffortId(carried) }
      : { provider, model }
    rt.emit(upsertRow(rt.state(), { kind: 'status', text: `Model is now ${provider}/${model}.` }))
    if (!supported) {
      rt.emit(upsertRow(rt.state(), {
        kind: 'status',
        text: `Effort "${carried}" not supported by ${model}; reset to default.`,
      }))
    }
  }

  /**
   * Open the `/effort` picker: resolve the live model's advertised efforts
   * and park `effortPicker` state — entries are the effort ids plus the
   * trailing reserved `default` entry, focus on the live effort (the
   * `default` entry when none is set or it is no longer in the list). Fail
   * closed: an unresolved model emits the no-model notice and unresolvable
   * levels emit a notice — never a fabricated list.
   */
  const openEffortPicker = async (): Promise<void> => {
    const route = rt.selection.current
    if (route === undefined) {
      rt.emit(upsertRow(rt.state(), { kind: 'status', text: 'No model configured. Use /model first.' }))
      return
    }
    const efforts = await rt.resolveEfforts(route.provider, route.model)
    if (efforts === undefined || efforts.length === 0) {
      rt.emit(upsertRow(rt.state(), { kind: 'status', text: `Cannot resolve effort levels for ${route.model}.` }))
      return
    }
    const entries = [...efforts.map(level => level.id), 'default']
    const index = route.reasoningEffort === undefined ? -1 : entries.indexOf(route.reasoningEffort)
    rt.emit(setEffortPicker(rt.state(), {
      entries,
      focused: index >= 0 ? index : entries.length - 1,
      current: route.reasoningEffort,
    }))
  }

  /**
   * Open the `/permissions` picker: park the five CC rule-engine modes,
   * focused on the live mode (row 0 when the live mode is not in the list).
   * The overlay always opens — an unmounted engine surfaces as a host-command
   * error on submit, matching the argued `/permissions <mode>` path.
   */
  const openPermissionPicker = (): void => {
    const currentMode = rt.liveMode(rt.current.agent)
    const index = PERMISSION_MODE_OPTIONS.findIndex(option => option.id === currentMode)
    rt.emit(setPermissionPicker(rt.state(), {
      entries: PERMISSION_MODE_OPTIONS,
      focused: index >= 0 ? index : 0,
      current: currentMode,
    }))
  }

  return {
    openModelPicker,
    applyModelSwitch,
    openEffortPicker,
    openPermissionPicker,
    modelPickerMove(delta) {
      rt.emit(moveModelPickerFocus(rt.state(), delta))
    },
    modelPickerSubmit(): Promise<void> {
      const picker = rt.state().modelPicker
      if (picker === undefined) return Promise.resolve()
      const entry = picker.entries[picker.focused]
      // Read-then-close: capture the focused entry BEFORE the synchronous
      // close-emit so the overlay never lingers while validation runs.
      rt.emit(setModelPicker(rt.state(), undefined))
      if (entry === undefined) return Promise.resolve()
      // Effort-preserving switch with the stale-pair guard inside; the bare
      // fast path writes synchronously, a carried effort continues detached.
      return applyModelSwitch(entry.provider, entry.id)
    },
    modelPickerCancel() {
      rt.emit(setModelPicker(rt.state(), undefined))
    },
    effortPickerMove(delta) {
      rt.emit(moveEffortPickerFocus(rt.state(), delta))
    },
    async effortPickerSubmit(): Promise<void> {
      const picker = rt.state().effortPicker
      if (picker === undefined) return
      const entry = picker.entries[picker.focused]
      // Read-then-close (mirror modelPickerSubmit): capture the focused entry
      // BEFORE the synchronous close-emit, then validate+write detached.
      rt.emit(setEffortPicker(rt.state(), undefined))
      if (entry === undefined) return
      const captured: SelectionRoute | undefined = rt.selection.current
      if (captured === undefined) {
        rt.emit(upsertRow(rt.state(), { kind: 'status', text: 'No model configured. Use /model first.' }))
        return
      }
      // The reserved `default` entry resets to the bare pair with zero
      // validation (the provider default is always legal); the stale-pair
      // guard still applies.
      if (entry === 'default') {
        if (rt.stalePair(captured)) return
        rt.selection.current = { provider: captured.provider, model: captured.model }
        rt.emit(upsertRow(rt.state(), { kind: 'status', text: 'Reasoning effort reset to the provider default.' }))
        return
      }
      const efforts = await rt.resolveEfforts(captured.provider, captured.model)
      // Stale-pair guard: the captured model must still be the live selection
      // when the validation continuation resumes — a concurrent /model or
      // switchSession re-seed in between refuses the write.
      if (rt.stalePair(captured)) return
      const level = efforts?.find(candidate => candidate.id === entry)
      if (level === undefined) {
        rt.emit(upsertRow(rt.state(), { kind: 'status', text: `Cannot resolve effort levels for ${captured.model}.` }))
        return
      }
      rt.selection.current = {
        provider: captured.provider,
        model: captured.model,
        reasoningEffort: ReasoningEffortId(level.id),
      }
      rt.emit(upsertRow(rt.state(), { kind: 'status', text: `Reasoning effort is now ${level.name}.` }))
    },
    effortPickerCancel() {
      rt.emit(setEffortPicker(rt.state(), undefined))
    },
    permissionPickerMove(delta) {
      rt.emit(movePermissionPickerFocus(rt.state(), delta))
    },
    async permissionPickerSubmit(): Promise<void> {
      const picker = rt.state().permissionPicker
      if (picker === undefined) return
      const entry = picker.entries[picker.focused]
      if (entry === undefined) {
        rt.emit(setPermissionPicker(rt.state(), undefined))
        return
      }
      // bypassPermissions parks an in-overlay confirmation first; a second
      // enter (or any other mode) closes then writes through the host command.
      if (entry.id === BYPASS_MODE && picker.confirmingBypass !== true) {
        rt.emit(setPermissionPicker(rt.state(), { ...picker, confirmingBypass: true }))
        return
      }
      rt.emit(setPermissionPicker(rt.state(), undefined))
      await rt.runHarness(`/permissions ${entry.id}`)
    },
    permissionPickerCancel() {
      const picker = rt.state().permissionPicker
      if (picker === undefined) return
      if (picker.confirmingBypass === true) {
        const { confirmingBypass: _dropped, ...rest } = picker
        rt.emit(setPermissionPicker(rt.state(), rest))
        return
      }
      rt.emit(setPermissionPicker(rt.state(), undefined))
    },
    async loadModelCatalog(): Promise<CatalogEntry[]> {
      return rt.loadCatalog()
    },
    async loadModelEfforts(): Promise<string[]> {
      const route = rt.selection.current
      if (route === undefined) return []
      const efforts = await rt.resolveEfforts(route.provider, route.model)
      if (efforts === undefined) return []
      return [...efforts.map(level => level.id), 'default']
    },
  }
}

export type { SelectionRoute, CatalogEntry, TuiState }
