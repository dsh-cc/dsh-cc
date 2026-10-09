/**
 * Outbox queue reducers: submissions parked while the agent is busy.
 *
 * A chip is a `QueuedChip` - the submitted text plus the clipboard images
 * captured with it - not a bare string. The images cannot be re-derived later
 * (the editor's image registry belongs to the composer that was just cleared),
 * so they have to be parked with the text or a paste made while busy is lost
 * (plan 3.5).
 * @module @dsh-cc/tui/store/queue
 */
import type { PastedImage } from '@dsh-cc/pi-tui'
import type { QueuedChip, TuiState } from './views.ts'

/**
 * Park a submission as pending work while the agent is busy. A submission with
 * no images stores no `images` field at all - see QueuedChip.
 */
export function enqueue(state: TuiState, text: string, images?: readonly PastedImage[]): TuiState {
  const chip: QueuedChip = images === undefined || images.length === 0 ? { text } : { text, images }
  return { ...state, queued: [...state.queued, chip] }
}

/**
 * Remove the FIRST queued entry whose text is strictly equal to `text`. No-op
 * (returns the same reference) when the text is absent. Kept for outbox
 * bookkeeping and tests - chip clearing in the live driver is synchronous
 * (flush / Ctrl+S / interrupt / recall), never event-driven.
 */
export function dequeue(state: TuiState, text: string): TuiState {
  const index = state.queued.findIndex(chip => chip.text === text)
  if (index < 0) return state
  const queued = state.queued.slice(0, index).concat(state.queued.slice(index + 1))
  return { ...state, queued }
}

/**
 * Remove and return the LAST queued chip - LIFO, so an editor recall hands back
 * the most recent submit. Same reference and `undefined` chip on an empty
 * queue; callers treat that as "nothing to recall" and fall through.
 *
 * The whole chip comes back, not just its text: a recall has to know whether
 * the entry carried images, which it cannot restore (see the driver's
 * recallQueued).
 */
export function popQueued(state: TuiState): { state: TuiState; chip: QueuedChip | undefined } {
  if (state.queued.length === 0) return { state, chip: undefined }
  return { state: { ...state, queued: state.queued.slice(0, -1) }, chip: state.queued.at(-1) }
}

/** Drop every queued chip (e.g. on interrupt — matches cancel's inbox clear). */
export function clearQueue(state: TuiState): TuiState {
  if (state.queued.length === 0) return state
  return { ...state, queued: [] }
}
