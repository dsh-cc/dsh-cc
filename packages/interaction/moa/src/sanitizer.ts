/**
 * The model-selection notice sanitizer (effective-model-truth design §5.1).
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
 * before the inner chain runs and can filter the harness's
 * `model-selection` notice rows that inner listeners appended.
 *
 * Drop rule: drop the harness's model-selection notice rows IFF moa's overlay
 * is active AND the assembled pair equals the moa boot pair — i.e. exactly
 * when the notice's advertised continuation model is what the overlay will
 * NOT serve (a phantom). Everything else passes through byte-identical (G5).
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { isSubagentAgent } from './agent-scope.ts'
import { moaBootDefault, moaOverlayActive, pairOf, publishLiveSelection, type RequestPair } from './runtime-state.ts'

/** Field comparison (provider/model) — NEVER object identity (design §3). */
const sameFields = (a: RequestPair, b: RequestPair): boolean =>
  a.provider === b.provider && a.model === b.model

/**
 * Install the sanitizer in one agent's scope.
 * @param agentCtx - the selected agent's scoped context (same scope the
 *   companion `installModelSelection` was registered in).
 * @param selection - the SAME `ModelSelectionRef` handed to
 *   `installModelSelection` (read from the same closure).
 * @returns disposer for the pre-step listener.
 */
export function installModelSelectionSanitizer(agentCtx: Context, selection: ModelSelectionRef): () => void {
  const listener = async (
    payload: { agent?: unknown },
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    // Publish BEFORE next(): the FROZEN snapshot for this step — deliberately
    // `selection.assembled`, NOT `selection.current` (round-4 finding): a
    // `/model` switch resolving mid-assembly leaves `assembled` frozen on the
    // pre-switch pair for the step, and publishing `current` would disarm at
    // pre-step while the request-time observe of the same frozen pair re-arms
    // and overlays. Subagent-guarded before any shared-state touch.
    if (!isSubagentAgent(payload.agent)) {
      const pair = pairOf(selection.assembled)
      if (pair !== undefined) publishLiveSelection(payload.agent, pair)
    }
    const decision = (await next()) as
      | { kind?: string; messages?: readonly { source?: { kind?: string } }[] }
      | undefined
    // Pass through undefined / reject / undefined-messages decisions
    // unchanged.
    if (decision === undefined || decision.kind === 'reject' || decision.messages === undefined) {
      return decision
    }
    const active = moaOverlayActive()
    const boot = moaBootDefault()
    const assembled = pairOf(selection.assembled)
    const drop = active && assembled !== undefined && boot !== undefined && sameFields(assembled, boot)
    if (!drop) return decision
    // Copied decision with the (phantom) model-selection rows filtered out.
    return {
      ...decision,
      messages: decision.messages.filter((m) => m.source?.kind !== 'model-selection'),
    }
  }
  return agentCtx.on('agent/pre-step', listener as never, { prepend: true })
}
