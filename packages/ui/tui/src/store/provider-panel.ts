/**
 * `/provider` panel reducer (design doc §4.2–§4.4): pure phase transitions for
 * the list / detail / wizard / confirm-remove overlay. No I/O — rows and steps
 * arrive from the caller (see provider-flow.ts for the list merge rule).
 * @module @dsh-cc/tui/store/provider-panel
 */
import type { MoreProviderRow, ProviderRow } from '../provider-flow.ts'
import type { TuiState } from './views.ts'

/**
 * Park or clear the open `/provider` overlay in the aggregate state. The
 * panel phase/cursor/rows come from this module's pure reducers; the driver
 * re-parks the whole state after each transition.
 */
export function setProviderOverlay(state: TuiState, panel: ProviderPanelState | undefined): TuiState {
  if (panel === undefined) {
    if (state.providerPanel === undefined) return state
    const { providerPanel: _dropped, ...rest } = state
    return rest
  }
  return { ...state, providerPanel: panel }
}

export type ProviderPanelState = {
  phase: 'list' | 'detail' | 'wizard' | 'confirm-remove'
  cursor: number
  rows: readonly ProviderRow[]
  /** Directory tail collapsed under "More providers…" (§4.2 merge rule). */
  more: readonly MoreProviderRow[]
  /** Route the detail / wizard / confirm views target. */
  selected?: string
  wizard?: {
    kind: 'preset' | 'custom' | 'rotate'
    route: string
    displayName?: string
    steps: readonly string[]
    stepIndex: number
    /** Non-secret answers only (§6): the API key never lands here. */
    answers: Record<string, string>
    /** Selection cursor for single-choice steps (protocol pick). */
    selectIndex?: number
    /** Verify-step outcome (§4.3.2). */
    verify?: { status: 'pending' | 'ok' | 'failed' | 'skipped'; message?: string }
    /** Per-entry model-list parse errors (§4.6). */
    modelErrors?: string[]
    note?: string
  }
  /** Detail-view facts (§4.4), computed by the runtime at enter time. */
  detail?: { profileJson: string; endpoint: string; api: string; modelCount: number; credentialLine: string }
  /** Detail action rows, precomputed by the runtime (disabled carries its reason). */
  actions?: readonly { id: string; label: string; disabled?: boolean; reason?: string }[]
  actionCursor?: number
  /** Remove double-confirm stage: the unset confirm, then the managed-credential drop offer. */
  stage?: 'confirm' | 'drop-credential'
  message?: string
}

/** Open the overlay on its list home (§4.2). */
export function openProviderPanel(rows: readonly ProviderRow[], more: readonly MoreProviderRow[] = []): ProviderPanelState {
  return { phase: 'list', cursor: 0, rows, more }
}

/** Move the list cursor by one row, clamped without wrapping. */
export function moveCursor(state: ProviderPanelState, delta: -1 | 1): ProviderPanelState {
  if (state.phase !== 'list' || state.rows.length === 0) return state
  return { ...state, cursor: Math.max(0, Math.min(state.cursor + delta, state.rows.length - 1)) }
}

/** Enter the manage view (§4.4) for the focused configured row. */
export function enterDetail(state: ProviderPanelState): ProviderPanelState {
  const row = state.rows[state.cursor]
  if (state.phase !== 'list' || row === undefined) return state
  return { ...state, phase: 'detail', selected: row.route }
}

/** Back to the list (esc from detail/confirm); clears the selection, any message, and action state. */
export function backToList(state: ProviderPanelState): ProviderPanelState {
  if (state.phase !== 'detail' && state.phase !== 'confirm-remove') return state
  const { selected: _s, message: _m, stage: _st, detail: _d, actions: _a, actionCursor: _c, ...rest } = state
  return { ...rest, phase: 'list' }
}

/** Begin the add flow (§4.3/§4.6) for a preset or custom route with its ordered steps. */
export function startWizardFor(
  state: ProviderPanelState,
  route: string,
  steps: readonly string[],
  opts: { kind?: 'preset' | 'custom' | 'rotate'; displayName?: string; answers?: Record<string, string> } = {},
): ProviderPanelState {
  if (steps.length === 0) return state
  return {
    ...state,
    phase: 'wizard',
    wizard: {
      kind: opts.kind ?? 'preset',
      route,
      ...(opts.displayName === undefined ? {} : { displayName: opts.displayName }),
      steps,
      stepIndex: 0,
      answers: opts.answers ?? {},
      selectIndex: 0,
    },
  }
}

/** Record one wizard answer without mutating prior state. */
export function wizardSetAnswer(state: ProviderPanelState, key: string, value: string): ProviderPanelState {
  if (state.wizard === undefined) return state
  return { ...state, wizard: { ...state.wizard, answers: { ...state.wizard.answers, [key]: value } } }
}

/** Advance one wizard step, clamped at the last (the caller completes from there). */
export function wizardNext(state: ProviderPanelState): ProviderPanelState {
  const wizard = state.wizard
  if (state.phase !== 'wizard' || wizard === undefined) return state
  return { ...state, wizard: { ...wizard, stepIndex: Math.min(wizard.stepIndex + 1, wizard.steps.length - 1) } }
}

/** Step back one wizard step; clamped at the first. */
export function wizardBack(state: ProviderPanelState): ProviderPanelState {
  const wizard = state.wizard
  if (state.phase !== 'wizard' || wizard === undefined) return state
  return { ...state, wizard: { ...wizard, stepIndex: Math.max(wizard.stepIndex - 1, 0) } }
}

/** Leave the wizard back to the list (esc path); drops wizard state. */
export function backFromWizard(state: ProviderPanelState): ProviderPanelState {
  if (state.phase !== 'wizard') return state
  const { wizard: _w, message: _m, ...rest } = state
  return { ...rest, phase: 'list' }
}

/** Arm the remove double-confirm (§4.4) from the detail view. */
export function startRemove(state: ProviderPanelState): ProviderPanelState {
  if (state.phase !== 'detail' || state.selected === undefined) return state
  return { ...state, phase: 'confirm-remove', stage: 'confirm' }
}

/** Move the detail action cursor by one row, clamped without wrapping. */
export function moveDetailCursor(state: ProviderPanelState, delta: -1 | 1): ProviderPanelState {
  const count = state.actions?.length ?? 0
  if (state.phase !== 'detail' || count === 0) return state
  const cursor = Math.max(0, Math.min((state.actionCursor ?? 0) + delta, count - 1))
  return { ...state, actionCursor: cursor }
}

/** Park the detail facts + action rows computed by the runtime. */
export function setDetail(state: ProviderPanelState, detail: ProviderPanelState['detail'], actions: ProviderPanelState['actions']): ProviderPanelState {
  if (state.phase !== 'detail') return state
  return { ...state, ...(detail === undefined ? {} : { detail }), ...(actions === undefined ? {} : { actions }), actionCursor: state.actionCursor ?? 0 }
}

/** Wizard single-choice cursor (protocol pick). */
export function wizardSetSelectIndex(state: ProviderPanelState, index: number): ProviderPanelState {
  if (state.wizard === undefined) return state
  return { ...state, wizard: { ...state.wizard, selectIndex: index } }
}

/** Park the verify-step outcome (§4.3.2). */
export function wizardSetVerify(state: ProviderPanelState, verify: { status: 'pending' | 'ok' | 'failed' | 'skipped'; message?: string } | undefined): ProviderPanelState {
  if (state.wizard === undefined) return state
  const { verify: _dropped, ...wizard } = state.wizard
  return { ...state, wizard: verify === undefined ? wizard : { ...wizard, verify } }
}

/** Park per-entry model-list parse errors (§4.6). */
export function wizardSetModelErrors(state: ProviderPanelState, errors: string[]): ProviderPanelState {
  if (state.wizard === undefined) return state
  const { modelErrors: _dropped, ...wizard } = state.wizard
  return { ...state, wizard: errors.length === 0 ? wizard : { ...wizard, modelErrors: errors } }
}

/** Park a wizard note (env-skip line, validator refusal, verify reason). */
export function wizardSetNote(state: ProviderPanelState, note: string | undefined): ProviderPanelState {
  if (state.wizard === undefined) return state
  const { note: _dropped, ...wizard } = state.wizard
  return { ...state, wizard: note === undefined ? wizard : { ...wizard, note } }
}

/** Move the remove confirm between the unset confirm and the credential-drop offer. */
export function setRemoveStage(state: ProviderPanelState, stage: NonNullable<ProviderPanelState['stage']>): ProviderPanelState {
  if (state.phase !== 'confirm-remove') return state
  return { ...state, stage }
}

/** Cancel the remove confirmation (esc path) — back to the detail view. */
export function cancelRemove(state: ProviderPanelState): ProviderPanelState {
  if (state.phase !== 'confirm-remove') return state
  return { ...state, phase: 'detail' }
}

/** Show a one-line note (e.g. "N models reachable", verify-failure reason). */
export function setMessage(state: ProviderPanelState, message: string | undefined): ProviderPanelState {
  if (message === undefined) {
    const { message: _dropped, ...rest } = state
    return rest
  }
  return { ...state, message }
}
