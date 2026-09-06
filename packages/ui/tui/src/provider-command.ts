/**
 * `/provider` command runtime (design doc docs/plans/2026-09-05-provider-
 * management.md §4.1–§4.2, §5): the driver's provider panel section —
 * open/close, the runtime dispatch surface, and live-refresh event wiring.
 * Read paths live in provider-read.ts; the wizard engines in
 * provider-actions.ts; detail/manage/remove in provider-detail.ts.
 * @module @dsh-cc/tui/provider-command
 */
import { Input } from '@dsh-cc/pi-tui'
import { MaskedInput } from './components/masked-input.ts'
import { upsertRow, setProviderOverlay, type TuiState } from './store.ts'
import {
  backFromWizard,
  backToList,
  cancelRemove,
  moveCursor,
  moveDetailCursor,
  setMessage,
  openProviderPanel as openPanelState,
  startWizardFor,
  wizardBack,
  wizardSetNote,
  wizardSetSelectIndex,
  type ProviderPanelState,
} from './store/provider-panel.ts'
import {
  buildProviderRows,
  type CredentialState,
  type CredentialsLike,
  type LlmManageLike,
  type ProviderList,
} from './provider-flow.ts'
import {
  PROVIDER_USAGE,
  credentialStates,
  loadDirectory,
  parseProviderArgs,
  readConfiguredProviders,
  renderProviderList,
  type SettingsDescribeLike,
} from './provider-read.ts'
import {
  CUSTOM_PROTOCOLS,
  CUSTOM_STEPS,
  TEXT_STEPS,
  clearField,
  createActions,
  credentialRefFor,
  currentStep,
  openField,
  reopenField,
} from './provider-actions.ts'
import { createDetail } from './provider-detail.ts'

export {
  PROVIDER_SETTINGS_NAMESPACE,
  PROVIDER_USAGE,
  credentialStates,
  loadDirectory,
  parseProviderArgs,
  readConfiguredProviders,
  renderProviderList,
} from './provider-read.ts'
export type { ParsedProviderArgs, SettingsDescribeLike } from './provider-read.ts'
export type { ProviderSettingsOp, SettingsWriteLike } from './provider-settings.ts'

/**
 * The shared seam passed from the runtime (here) into the wizard engines
 * (provider-actions.ts) and the detail/manage flows (provider-detail.ts):
 * the driver section deps, the transient field/secret/pending buffers, and
 * the emit/patch helpers.
 */
export interface ProviderCore {
  rt: ProviderSectionDeps
  /** Wizard text field + transient key buffer + in-flight action (§6). */
  buf: { field?: Input | MaskedInput | undefined; secret?: string | undefined; pendingAction?: Promise<void> | undefined }
  /** The assembled runtime (late-bound sibling method calls). */
  runtime(): ProviderRuntime
  /** Emit a provider-panel reducer result, if the panel is open. */
  patch(fn: (panel: ProviderPanelState) => ProviderPanelState): void
  /** Track one in-flight action (Enter/Esc become no-ops while pending). */
  begin(promise: Promise<void>): void
  /** Best-effort credential describe (unknown state → undefined). */
  describeRef(ref: string): Promise<CredentialState | undefined>
}

/** The driver section's duck-typed host surface (mirrors other sections' `rt`). */
export type ProviderSectionDeps = {
  emit(next: TuiState): void
  state(): TuiState
  ctx: {
    get(key: string): unknown
    on(event: unknown, handler: unknown): unknown
  }
  /** Live model selection; `current.provider` backs the current marker. */
  selection: { current: { provider?: string } | undefined }
}

/**
 * The `/provider` runtime exposed on the driver. `panelMove/panelSubmit/
 * panelCancel` back `routeProviderPanelInput`.
 */
export interface ProviderRuntime {
  openProviderPanel(arg?: string): Promise<void>
  closeProviderPanel(): void
  get llmManage(): LlmManageLike | undefined
  get credentials(): CredentialsLike | undefined
  refreshProviderRows(): Promise<void>
  panelMove(delta: -1 | 1): void
  panelSubmit(): void
  panelCancel(): void
  /** Phase of the open panel (input router's phase-dependent key map). */
  panelPhase(): ProviderPanelState['phase'] | undefined
  /** Feed one printable keypress into the wizard's live text field. */
  panelType(text: string): void
  /** Backspace in the wizard's live text field. */
  panelBackspace(): void
  /** Esc semantics: back one wizard step; at the first step close with a note. */
  panelEscape(): void
  /** Tab on the models step: run the draft-form probe and prefill the ids. */
  panelToggleFetch(): void
  /** Secondary choice: keep/remove on a failed verify; keep-credential on the drop offer. */
  panelSecondary(): void
  /** Detail-phase `r`: refresh the route's model list via a draft-form probe (§8-S2). */
  panelRefreshModels(): void
  /** Begin the custom-provider wizard (§4.6) from the list phase. */
  startCustomWizard(): void
  /** §4.3 add flow for a preset (custom wizard seeded for unknown ids). */
  startPresetWizard(route: string): Promise<void>
  /** §4.4 removal jump for `/provider remove <route>`. */
  jumpToRemove(route: string): void
  /** Enter on the focused list row: detail (configured) or add wizard (available). */
  enterFromList(panel: ProviderPanelState): void
  /** Run the focused detail action (§4.4). */
  runDetailAction(panel: ProviderPanelState): void
  /** Adjudicate the remove double-confirm / credential-drop stage. */
  confirmRemove(panel: ProviderPanelState): void
  /** Advance the wizard from its current step. */
  wizardSubmit(panel: ProviderPanelState): void
  /** Models-step fetch (tab): draft-form probe → prefill. */
  fetchModels(panel: ProviderPanelState): void
  /** keep/remove choice on a failed verify — remove unsets the just-written route. */
  removeJustAdded(panel: ProviderPanelState): void
  /** The live wizard text field, if a text step is active (test/render seam). */
  wizardInput(): Input | MaskedInput | undefined
}

/** Cordis events that re-render the open overlay (doc §4.2 / C2 / C4). */
const REFRESH_EVENTS = ['llm/adapters-updated', 'credentials/reference-updated']

/**
 * Create the provider panel section: fetches configured + directory +
 * credential states, seeds the store reducer, opens the overlay, and keeps
 * the list live via cordis events while open (disposed on close).
 */
export function createProviderSection(rt: ProviderSectionDeps): ProviderRuntime {
  let unsubs: Array<() => void> = []

  const subscribeWhileOpen = (): void => {
    if (unsubs.length > 0) return
    for (const event of REFRESH_EVENTS) {
      const un = rt.ctx.on(event as Parameters<typeof rt.ctx.on>[0], () => {
        void runtime.refreshProviderRows()
      })
      if (typeof un === 'function') unsubs.push(un as () => void)
    }
  }

  const unsubscribe = (): void => {
    for (const un of unsubs) un()
    unsubs = []
  }

  const patch = (fn: (panel: ProviderPanelState) => ProviderPanelState): void => {
    const panel = rt.state().providerPanel
    if (panel === undefined) return
    rt.emit(setProviderOverlay(rt.state(), fn(panel)))
  }

  const begin = (promise: Promise<void>): void => {
    buf.pendingAction = promise.finally(() => { buf.pendingAction = undefined })
  }

  const describeRef = async (ref: string): Promise<CredentialState | undefined> => {
    const credentials = rt.ctx.get('credentials') as CredentialsLike | undefined
    if (credentials === undefined || typeof credentials.describe !== 'function') return undefined
    try {
      return await credentials.describe(ref) ?? undefined
    } catch {
      return undefined
    }
  }

  // Wizard text field + transient key buffer. A typed key lives ONLY here —
  // cleared on submit and on close — never in the store, view snapshots, the
  // transcript, or the field's retained state after submit (§6).
  const buf: ProviderCore['buf'] = { field: undefined, secret: undefined, pendingAction: undefined }
  const core: ProviderCore = { rt, buf, runtime: () => runtime, patch, begin, describeRef }

  const runtime: ProviderRuntime = {
    get llmManage() {
      return rt.ctx.get('llm') as LlmManageLike | undefined
    },
    get credentials() {
      return rt.ctx.get('credentials') as CredentialsLike | undefined
    },
    async openProviderPanel(arg?: string): Promise<void> {
      const parsed = parseProviderArgs(arg ?? '')
      if (parsed.kind === 'list') {
        const text = renderProviderList(await fetchList())
        rt.emit(upsertRow(rt.state(), { kind: 'status', text }))
        return
      }
      if (parsed.kind === 'invalid') {
        rt.emit(upsertRow(rt.state(), { kind: 'status', text: PROVIDER_USAGE }))
        return
      }
      await runtime.refreshProviderRows()
      subscribeWhileOpen()
      if (parsed.kind === 'add') await runtime.startPresetWizard(parsed.route)
      if (parsed.kind === 'remove') runtime.jumpToRemove(parsed.route)
    },
    closeProviderPanel(): void {
      clearField(core)
      unsubscribe()
      rt.emit(setProviderOverlay(rt.state(), undefined))
    },
    async refreshProviderRows(): Promise<void> {
      const list = await fetchList()
      rt.emit(setProviderOverlay(rt.state(), openPanelState([...list.configured, ...list.available], list.more)))
    },
    panelPhase(): ProviderPanelState['phase'] | undefined {
      return rt.state().providerPanel?.phase
    },
    panelMove(delta: -1 | 1): void {
      const panel = rt.state().providerPanel
      if (panel === undefined) return
      if (panel.phase === 'wizard' && panel.wizard?.steps[panel.wizard.stepIndex] === 'protocol') {
        const next = Math.max(0, Math.min((panel.wizard.selectIndex ?? 0) + delta, CUSTOM_PROTOCOLS.length - 1))
        rt.emit(setProviderOverlay(rt.state(), wizardSetSelectIndex(panel, next)))
        return
      }
      if (panel.phase === 'detail') {
        rt.emit(setProviderOverlay(rt.state(), moveDetailCursor(panel, delta)))
        return
      }
      rt.emit(setProviderOverlay(rt.state(), moveCursor(panel, delta)))
    },
    panelSubmit(): void {
      const panel = rt.state().providerPanel
      if (panel === undefined || buf.pendingAction !== undefined) return
      if (panel.phase === 'list') {
        runtime.enterFromList(panel)
        return
      }
      if (panel.phase === 'detail') {
        runtime.runDetailAction(panel)
        return
      }
      if (panel.phase === 'confirm-remove') {
        runtime.confirmRemove(panel)
        return
      }
      if (panel.phase === 'wizard') {
        runtime.wizardSubmit(panel)
      }
    },
    panelCancel(): void {
      runtime.closeProviderPanel()
    },
    panelType(text: string): void {
      const active = currentStep(rt.state().providerPanel)
      if (buf.field !== undefined && active !== undefined && TEXT_STEPS[active] !== undefined) buf.field.handleInput(text)
    },
    panelBackspace(): void {
      if (buf.field !== undefined) buf.field.handleInput('\x7f')
    },
    panelEscape(): void {
      const panel = rt.state().providerPanel
      if (panel === undefined || buf.pendingAction !== undefined) return
      if (panel.phase === 'wizard') {
        const wizard = panel.wizard
        clearField(core)
        if (wizard !== undefined && wizard.stepIndex > 0 && wizard.steps[wizard.stepIndex] !== 'done') {
          rt.emit(setProviderOverlay(rt.state(), wizardSetNote(wizardBack(panel), undefined)))
          reopenField(core, rt.state().providerPanel)
        } else {
          // First step (or the done step — the write already landed): close.
          const wrote = wizard !== undefined && wizard.stepIndex === wizard.steps.length - 1
          rt.emit(setProviderOverlay(rt.state(), setMessage(backFromWizard(panel), wrote ? undefined : 'Wizard closed — nothing was written.')))
        }
        return
      }
      if (panel.phase === 'detail') {
        rt.emit(setProviderOverlay(rt.state(), backToList(panel)))
        return
      }
      if (panel.phase === 'confirm-remove') {
        rt.emit(setProviderOverlay(rt.state(), cancelRemove(panel)))
        return
      }
      runtime.closeProviderPanel()
    },
    panelToggleFetch(): void {
      const panel = rt.state().providerPanel
      if (panel === undefined || buf.pendingAction !== undefined) return
      runtime.fetchModels(panel)
    },
    panelSecondary(): void {
      const panel = rt.state().providerPanel
      if (panel === undefined || buf.pendingAction !== undefined) return
      if (panel.phase === 'confirm-remove' && panel.stage === 'drop-credential') {
        // Keep the stored credential.
        rt.emit(setProviderOverlay(rt.state(), backToList(panel)))
        return
      }
      if (panel.phase === 'wizard' && panel.wizard?.verify?.status === 'failed') {
        runtime.removeJustAdded(panel)
      }
    },
    startCustomWizard(): void {
      const panel = rt.state().providerPanel
      if (panel === undefined || panel.phase !== 'list') return
      rt.emit(setProviderOverlay(rt.state(), startWizardFor(panel, '', [...CUSTOM_STEPS], { kind: 'custom' })))
      openField(core, rt.state().providerPanel)
    },
    wizardInput(): Input | MaskedInput | undefined {
      return buf.field
    },
    ...createActions(core),
    ...createDetail(core),
  }

  async function fetchList(): Promise<ProviderList> {
    const llm = rt.ctx.get('llm') as LlmManageLike | undefined
    const credentials = rt.ctx.get('credentials') as CredentialsLike | undefined
    const settings = rt.ctx.get('settings') as SettingsDescribeLike | undefined
    const configured = readConfiguredProviders(settings)
    const directory = loadDirectory(llm)
    const credentialRefs = [...new Set([...Object.keys(configured), ...directory.map(e => e.provider)])]
      .map(route => credentialRefFor(route))
    const states = await credentialStates(credentials, credentialRefs)
    return buildProviderRows({
      configured,
      directory,
      credentialStates: states,
      ...(rt.selection.current?.provider !== undefined ? { currentProvider: rt.selection.current.provider } : {}),
    })
  }

  return runtime
}
