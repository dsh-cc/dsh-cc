/**
 * Model-selection wiring with the moa sanitizer co-located
 * (effective-model-truth design §5.1; harness-0.2.2 D3.1): the sanitizer
 * MUST register in the same closure, immediately after the 1-arg
 * `installModelSelection`, so that its later-with-prepend `agent/pre-step`
 * listener becomes the outermost one and publishes the frozen per-step
 * selection (`payload.modelSelection`) for moa's tripwire before the inner
 * chain runs. A call site using this helper is a co-located pair by
 * construction; the `@dsh-cc/moa/sanitizer` subpath is side-effect-free (no
 * plugin `apply()` path in its import graph).
 */
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { installModelSelectionSanitizer } from '@dsh-cc/moa/sanitizer'

export function installModelSelectionWithSanitizer(agentCtx: Context): void {
  installModelSelection(agentCtx)
  installModelSelectionSanitizer(agentCtx)
}
