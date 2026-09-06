/**
 * Plan/mode switching cluster for the in-process driver: the `/plan` channel
 * seam and permission-mode cycling. Verbatim extraction from harness/driver.ts
 * (applyMode / applyModeInner / cyclePermissionMode), reading shared state
 * through a DriverModeCtx instead of createDriver's closures.
 *
 * Plan is owned by plan-mode inside the preset's isolate realm; the ONLY
 * cross-plane write seam is the `/plan` command channel — dispatched bare,
 * never '/plan on' (the upstream handler steers any non-'off' argument into
 * the conversation as a user message).
 * @module @dsh-cc/tui/harness/driver-mode
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { isPermissionMode, nextPermissionMode, type PermissionCommandMode } from '../mode-cycle.ts'
import { PERMISSION_COMMAND_MODES, planPhaseOf, type PlanUnitStateLike } from '@dsh-cc/command-permissions'
import { setPermissionMode } from '../store.ts'
import type { TuiState } from '../store.ts'
import type { DriverModeCtx } from './driver-ctx.ts'

/** Returns the current permission-rules engine's setMode seam (duck-typed). */
type PermissionRulesSeam = { setMode(agent: Agent, mode: string): void }

/**
 * Free-function collaborator implementing the plan/mode writepath. Reads all
 * shared state/functions off `rt` (DriverModeCtx) so it never imports the
 * createDriver factory. `modeWrites` is a serialization gate held here; each
 * call chains onto the previous write so concurrent mode switches cannot
 * interleave.
 */
export function createModeSection(rt: DriverModeCtx): {
  applyMode(mode: PermissionCommandMode): void
  cyclePermissionMode(): Promise<void>
  get modeWrites(): Promise<void>
} {
  let modeWrites: Promise<void> = Promise.resolve()

  const applyMode = (mode: PermissionCommandMode): void => {
    modeWrites = modeWrites.then(() => applyModeInner(mode)).catch((error: unknown) => {
      rt.showNotice(error instanceof Error ? error.message : String(error))
    })
  }

  const applyModeInner = async (mode: PermissionCommandMode): Promise<void> => {
    if (mode === 'plan') {
      const result = await rt.runHarness('/plan')
      if (result === undefined) rt.showNotice('plan mode is not mounted in this composition')
      // No optimistic emit: the display re-folds from the committed plan/mode
      // event (see the session/event listener), so a queued mid-turn entry
      // stays truthful until it applies.
      return
    }
    const phase = planPhaseOf(
      rt.current.agent.session.events,
      rt.projections?.stateOf(rt.current.agent.session, 'plan') as PlanUnitStateLike | undefined,
    )
    if (phase !== 'off') {
      const exit = await rt.runHarness('/plan off')
      if (exit === null) return // no command registry — runHarness already noticed
      if (exit === undefined) {
        rt.showNotice('plan mode is not mounted in this composition')
        return
      }
      // A failed exit must not strand the switch half-done.
      if (exit.kind === 'error') return
    }
    const rules = rt.getRules()
    if (rules === undefined) {
      rt.showNotice('The permission-rules engine is not mounted in this composition.')
      return
    }
    rules.setMode(rt.current.agent, mode)
    // rebind-proof: emit reassigns createDriver's `state`, so read through the
    // getter for a fresh snapshot to drive setPermissionMode.
    const live = rt.state()
    rt.emit(setPermissionMode(live, mode))
  }

  return {
    applyMode,
    cyclePermissionMode() {
      // F1: the cycle start follows the live settings default when no fold
      // exists — but a settings defaultMode outside PERMISSION_COMMAND_MODES
      // must not become the start (one Tab press would never reach it and the
      // shown mode would be "lost"), so clamp non-members to 'default' first.
      const live = rt.liveMode(rt.current.agent)
      const start = isPermissionMode(live) ? live : 'default'
      const next = nextPermissionMode(start)
      if (!(PERMISSION_COMMAND_MODES as readonly string[]).includes(next)) return modeWrites
      applyMode(next)
      return modeWrites
    },
    get modeWrites() {
      return modeWrites
    },
  }
}

export type { PermissionRulesSeam }
export type { TuiState }
