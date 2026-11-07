/**
 * The model-selection notice sanitizer (effective-model-truth design §5.1;
 * harness-0.2.2 D3.2 final form).
 *
 * Exported via the `@dsh-cc/moa/sanitizer` subpath. SIDE-EFFECT-FREE module:
 * its import graph MUST NOT pull the plugin `apply()` path (index.ts) — it
 * reads the shared runtime state (runtime-state.ts) instead, whose accessors
 * return inert values when the moa plugin was never applied.
 *
 * Co-located registration (load-bearing, §5.1): call this immediately after
 * every `installModelSelection(...)` call site (packages/ui/tui
 * driver.ts `withSelection`, packages/acp/cc-acp model-control.ts `install`).
 * The `later-with-prepend` registration makes this the OUTERMOST
 * `agent/pre-step` listener (P-B): it publishes the frozen per-step selection
 * before the inner chain runs.
 *
 * 0.2.2 semantics: the frozen pair is `payload.modelSelection` of
 * `agent/pre-step` — the harness freezes the step's selection at preStep
 * start and stamps it on the payload. Notices are now TRUTHFUL BY
 * CONSTRUCTION (moa's pre-admission select IS the step selection), so the
 * phantom-notice drop rule is RETIRED: every `model-selection` notice row
 * passes through byte-identical (G5), and tier switches emit the harness's
 * truthful `[model changed]` notice (the effective-model-truth program's
 * intended end state — accepted delta, migration design §8 row 1).
 *
 * Kept: the live-selection publisher (feeding `observeLiveSelection`, now a
 * provenance-filtered tripwire per the r3-final arming rule) and the spec
 * tripwire asserting no phantom `model-selection` notice appears while armed.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { isSubagentAgent } from './agent-scope.ts'
import { pairOf, publishLiveSelection } from './runtime-state.ts'

/**
 * Install the sanitizer in one agent's scope.
 * @param agentCtx - the selected agent's scoped context (same scope the
 *   companion `installModelSelection` was registered in).
 * @returns disposer for the pre-step listener.
 */
export function installModelSelectionSanitizer(agentCtx: Context): () => void {
  const listener = async (
    payload: { agent?: unknown; modelSelection?: ModelSelection | undefined },
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    // Publish BEFORE next(): the FROZEN snapshot for this step —
    // `payload.modelSelection`, frozen by the loop at preStep start
    // (agent.ts: preStep reads model.current() once, then stamps it on the
    // payload). A `/model` switch landing mid-assembly cannot flip what this
    // step serves, and the tripwire observation sees exactly that frozen
    // pair. Subagent-guarded before any shared-state touch.
    if (!isSubagentAgent(payload.agent)) {
      const pair = pairOf(payload.modelSelection)
      if (pair !== undefined) publishLiveSelection(payload.agent, pair)
    }
    // Notices pass through byte-identical (G5) — the drop rule retired:
    // the harness's `model-selection` notice now advertises the selection the
    // step actually serves (moa's select IS the step selection), so there is
    // no phantom left to filter.
    return next()
  }
  return agentCtx.on('agent/pre-step', listener as never, { prepend: true })
}
