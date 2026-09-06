/**
 * Subagent-run reducers: capped run list, oldest-settled-first eviction.
 * @module @dsh-cc/tui/store/subagents
 */
import type { SubagentRunView, TuiState } from './views.ts'

/** Maximum subagent runs retained in state; oldest done drops first. */
const SUBAGENT_CAP = 20

/**
 * Drop entries from the front (oldest) until `runs` fits `cap`, preferring
 * to evict non-`running` runs (`done` and `parked` equally) before `running`
 * ones. Mutates a copy; callers pass the already-upserted list.
 */
function trimSubagents(runs: SubagentRunView[], cap: number): SubagentRunView[] {
  let result = runs
  while (result.length > cap) {
    const settledIndex = result.findIndex(run => run.status !== 'running')
    const dropAt = settledIndex >= 0 ? settledIndex : 0
    result = result.slice(0, dropAt).concat(result.slice(dropAt + 1))
  }
  return result
}

/**
 * Append or update a subagent run. Resumable rows (`resumable === true`) key
 * on `sessionId` — a cold-resume reuses the parked row even though the run
 * id changes — everything else pairs by `runId` (start then end updates in
 * place). The list is capped at {@link SUBAGENT_CAP}: when over, the oldest
 * non-running entry drops first, then the oldest `running`.
 */
export function upsertSubagent(state: TuiState, view: SubagentRunView): TuiState {
  const index = view.resumable === true
    ? state.subagents.findIndex(run => run.sessionId === view.sessionId)
    : state.subagents.findIndex(run => run.runId === view.runId)
  const next: SubagentRunView[] = index >= 0
    ? (() => {
      const updated = state.subagents.slice()
      updated[index] = view
      return updated
    })()
    : [...state.subagents, view]
  if (next.length === state.subagents.length && next.length <= SUBAGENT_CAP) {
    return { ...state, subagents: next }
  }
  return { ...state, subagents: trimSubagents(next, SUBAGENT_CAP) }
}

/** Count runs still in the `running` state (R5 statusline feed). */
export function countRunningSubagents(state: TuiState): number {
  return state.subagents.reduce((count, run) => count + (run.status === 'running' ? 1 : 0), 0)
}
