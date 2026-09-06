/**
 * Core session reducers: transcript rows, composer draft, busy/turn anchors,
 * permission mode, notices, approval parking, HUD merge, and the
 * thinking/tool-output display toggles.
 * @module @dsh-cc/tui/store/session
 */
import { VERBS } from '../working-line.ts'
import type { ApprovalView, HudView, TranscriptRow, TuiState } from './views.ts'

/** Empty composer + idle agent. */
export function createInitialState(permissionMode = 'default'): TuiState {
  return {
    rows: [],
    draft: '',
    busy: false,
    permissionMode,
    queued: [],
    thinkingExpanded: false,
    toolOutputExpanded: true,
    compactExpanded: false,
    subagents: [],
  }
}

/**
 * Append or replace a transcript row. Tool rows with the same `callId` are
 * updated in place so start/result share one trail line.
 */
export function upsertRow(state: TuiState, row: TranscriptRow): TuiState {
  if (row.kind === 'tool') {
    const index = state.rows.findIndex(existing => existing.kind === 'tool' && existing.callId === row.callId)
    if (index >= 0) {
      const rows = state.rows.slice()
      rows[index] = row
      return { ...state, rows }
    }
  }
  if (row.kind === 'assistant' || row.kind === 'thinking') {
    const last = state.rows.at(-1)
    if (last?.kind === row.kind) {
      const rows = state.rows.slice()
      rows[rows.length - 1] = { ...row, text: last.text + row.text }
      return { ...state, rows }
    }
  }
  return { ...state, rows: [...state.rows, row] }
}

/** Replace the composer draft. */
export function setDraft(state: TuiState, draft: string): TuiState {
  return { ...state, draft }
}

/** Mark the agent busy or idle. */
export function setBusy(state: TuiState, busy: boolean): TuiState {
  return { ...state, busy }
}

/**
 * Anchor a newly-running turn for the working line: elapsed time counts from
 * `startedAt`, the output-token delta from `outputBase` (which may be
 * undefined when the HUD was not yet seeded — the driver's tokenUsage
 * rebase pins it later). `verbIndex` is derived deterministically from
 * `startedAt`, so re-anchoring with the same timestamp is snapshot-stable.
 * The anchor object is built fresh with no `stepStartedAt`, so anchoring a
 * new turn also clears the step clock; the pure baseline pin may pass the
 * existing `stepStartedAt` through (the driver's tokenUsage rebase does) so
 * pinning the baseline does not reset a mid-step clock.
 */
export function setTurnActive(
  state: TuiState,
  activity: { startedAt: number; outputBase: number | undefined; stepStartedAt?: number | undefined },
): TuiState {
  return {
    ...state,
    turn: {
      startedAt: activity.startedAt,
      outputBase: activity.outputBase,
      verbIndex: activity.startedAt % VERBS.length,
      ...activity.stepStartedAt === undefined ? {} : { stepStartedAt: activity.stepStartedAt },
    },
  }
}

/**
 * Reset the working line's step clock (new tool call, or tool finished and
 * the model is thinking again). Turn-modifying only: with no live turn this
 * returns the same state reference — an idle tool event must never conjure
 * a phantom anchor. Leaves startedAt/outputBase/verbIndex untouched.
 */
export function resetTurnStep(state: TuiState, at: number): TuiState {
  if (state.turn === undefined) return state
  return { ...state, turn: { ...state.turn, stepStartedAt: at } }
}

/** Clear the turn anchor (turn ended, interrupted, or session switched). */
export function clearTurn(state: TuiState): TuiState {
  const { turn: _dropped, ...rest } = state
  return rest
}

/** Record the live permission-mode footer. */
export function setPermissionMode(state: TuiState, permissionMode: string): TuiState {
  return { ...state, permissionMode }
}

/**
 * Fold the latest `session/title` event into state (last-wins), or clear it
 * on session switch. Same-reference when the value is unchanged so the
 * window-title effect in the root subscriber fires only on real transitions.
 */
export function setSessionTitle(state: TuiState, title: string | undefined): TuiState {
  if (state.title === title) return state
  if (title === undefined) {
    const { title: _dropped, ...rest } = state
    return rest
  }
  return { ...state, title }
}

/** Park or clear an approval prompt. */
export function setApproval(state: TuiState, approval: ApprovalView | undefined): TuiState {
  const { approval: _dropped, ...rest } = state
  return approval === undefined ? rest : { ...rest, approval }
}

/** Drop the transcript rows (bind/switch helper; not the `/clear` command). */
export function clearRows(state: TuiState): TuiState {
  const { notice: _dropped, ...rest } = state
  return { ...rest, rows: [] }
}

/** Set a one-line status notice. */
export function setNotice(state: TuiState, notice: string | undefined): TuiState {
  const { notice: _dropped, ...rest } = state
  return notice === undefined ? rest : { ...rest, notice }
}

/**
 * Record the moment of an idle Ctrl+C press (the double-press-to-exit window
 * anchor). Pure state evolution — the window comparison itself lives at the
 * input layer.
 */
export function markExitAttempt(state: TuiState, at: number): TuiState {
  return { ...state, lastExitAttemptAt: at }
}

/** Flip the thinking-accordion expansion flag (Ctrl+O). */
export function toggleThinking(state: TuiState): TuiState {
  return { ...state, thinkingExpanded: !state.thinkingExpanded }
}

/**
 * Flip the global collapse state (Ctrl+O): everything expanded collapses,
 * anything else expands. Only the all-expanded state counts as "open" so the
 * toggle is a clean two-way switch between fully expanded and fully
 * collapsed, regardless of how the individual flags got there.
 */
export function toggleGlobalCollapse(state: TuiState): TuiState {
  const allExpanded = state.thinkingExpanded && state.toolOutputExpanded && state.compactExpanded
  return {
    ...state,
    thinkingExpanded: !allExpanded,
    toolOutputExpanded: !allExpanded,
    compactExpanded: !allExpanded,
  }
}

/**
 * Merge a HUD patch into `state.hud` (fields left undefined keep their
 * current values), or clear the HUD entirely when `patch` is undefined.
 * Returns the same state reference when the clear finds nothing to drop.
 */
export function setHud(state: TuiState, patch: Partial<HudView> | undefined): TuiState {
  if (patch === undefined) {
    if (state.hud === undefined) return state
    const { hud: _dropped, ...rest } = state
    return rest
  }
  const base = state.hud ?? {}
  const merged: HudView = {
    ...base,
    ...patch.contextPercent === undefined ? {} : { contextPercent: patch.contextPercent },
    ...patch.tokens === undefined ? {} : { tokens: patch.tokens },
    ...patch.contextTokens === undefined ? {} : { contextTokens: patch.contextTokens },
  }
  return { ...state, hud: merged }
}
