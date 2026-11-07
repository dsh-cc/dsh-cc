/**
 * The live selection face construction (harness-0.2.2 D3.1). Extracted from
 * driver.ts to keep it under the size gate; behavior is byte-identical.
 * @module
 */

import { type Agent, type AgentHandle, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { noteUserSelection } from '@dsh-cc/moa'
import type { DriverModelSelection } from '../state/driver-types.ts'

/**
 * The live selection face: reads route to `agent.model.current()` of the
 * CURRENT agent (durable recorded choice, else creation options / the boot
 * seed); `selectUser` is the sole USER write seam — `/model` and `/effort`
 * record the choice durably AND publish moa's explicit user-write signal
 * (D3.2 noteUserSelection: userBaseSelection + disarm/re-arm + the
 * `user-select` sidecar row). Boot seeds and moa's own selects never flow
 * through `selectUser`.
 */
export function createDriverSelectionFace(
  currentMutable: () => { handle: AgentHandle; agent: Agent } | undefined,
): DriverModelSelection {
  return {
    current: () => currentMutable()?.agent.model.current(),
    selectUser: (next) => {
      const agent = currentMutable()?.agent
      if (agent === undefined) return
      const recorded: ModelSelection = {
        provider: next.provider,
        model: next.model,
        ...(next.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(next.reasoningEffort) }),
      }
      agent.model.select(recorded)
      noteUserSelection(recorded)
    },
  }
}
