/**
 * Emit channel of the TUI driver: state rebinding plus listener notification
 * with per-listener fault isolation. Extracted from createDriver to keep the
 * factory under the 500-line budget.
 * @module @dsh-cc/tui/harness/driver-emit
 */

import type { TuiState } from '../store.ts'

export type UiFault = { at: number; message: string }

/**
 * Build the emit channel. `notice` is called on the FIRST listener fault only
 * (best-effort surfacing; reentry through it is safe because listeners are
 * already isolated). Each fault is logged to console.error — the guaranteed
 * channel — and recorded in a capped (5) tail for diagnostics.
 */
export function createEmitChannel(
  set: (next: TuiState) => void,
  notice: (text: string) => void,
): {
  emit(next: TuiState): void
  listeners: Set<(state: TuiState) => void>
  uiFaults: UiFault[]
} {
  const listeners = new Set<(state: TuiState) => void>()
  const uiFaults: UiFault[] = []
  let firstFaultNoticed = false
  const emit = (next: TuiState): void => {
    set(next)
    for (const listener of listeners) {
      try {
        listener(next)
      } catch (error) {
        // One throwing listener must never veto the others nor the emitter's
        // caller — a veto here is what latches the zombie-busy freeze.
        const message = error instanceof Error ? error.message : String(error)
        uiFaults.push({ at: Date.now(), message })
        if (uiFaults.length > 5) uiFaults.shift()
        console.error(`[tui] ui listener fault: ${message}`)
        if (!firstFaultNoticed) {
          firstFaultNoticed = true
          notice('⚠ UI fault: view recovered; details on stderr')
        }
      }
    }
  }
  return { emit, listeners, uiFaults }
}
