/**
 * Usage reducers: the live usage snapshot and the /usage panel overlay.
 * @module @dsh-cc/tui/store/usage
 */
import type { TuiState, UsageView } from './views.ts'

/**
 * Replace the live usage snapshot, or clear it when `usage` is undefined.
 * Returns the same state reference when the clear finds nothing to drop.
 */
export function setUsage(state: TuiState, usage: UsageView | undefined): TuiState {
  if (usage === undefined) {
    if (state.usage === undefined) return state
    const { usage: _dropped, ...rest } = state
    return rest
  }
  return { ...state, usage }
}

/** Open the `/usage` panel (a same-reference no-op when already open). */
export function openUsagePanel(state: TuiState): TuiState {
  if (state.usagePanel !== undefined) return state
  return { ...state, usagePanel: {} }
}

/** Close the `/usage` panel. */
export function closeUsagePanel(state: TuiState): TuiState {
  if (state.usagePanel === undefined) return state
  const { usagePanel: _dropped, ...rest } = state
  return rest
}
