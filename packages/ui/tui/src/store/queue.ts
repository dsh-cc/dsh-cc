/**
 * Outbox queue reducers: pending steering texts submitted while the agent
 * is busy.
 * @module @dsh-cc/tui/store/queue
 */
import type { TuiState } from './views.ts'

/** Park a submitted text as pending steering while the agent is busy. */
export function enqueue(state: TuiState, text: string): TuiState {
  return { ...state, queued: [...state.queued, text] }
}

/**
 * Remove the FIRST queued entry strictly equal to `text`. No-op (returns the
 * same reference) when the text is absent. Kept for outbox bookkeeping and
 * tests — chip clearing in the live driver is synchronous (flush / Ctrl+S /
 * interrupt / recall), never event-driven.
 */
export function dequeue(state: TuiState, text: string): TuiState {
  const index = state.queued.findIndex(entry => entry === text)
  if (index < 0) return state
  const queued = state.queued.slice(0, index).concat(state.queued.slice(index + 1))
  return { ...state, queued }
}

/**
 * Remove and return the LAST queued entry — LIFO, so an editor recall hands
 * back the most recent submit. Same reference and `undefined` text on an
 * empty queue; callers treat that as "nothing to recall" and fall through.
 */
export function popQueued(state: TuiState): { state: TuiState; text: string | undefined } {
  if (state.queued.length === 0) return { state, text: undefined }
  return { state: { ...state, queued: state.queued.slice(0, -1) }, text: state.queued.at(-1) }
}

/** Drop every queued chip (e.g. on interrupt — matches cancel's inbox clear). */
export function clearQueue(state: TuiState): TuiState {
  if (state.queued.length === 0) return state
  return { ...state, queued: [] }
}
