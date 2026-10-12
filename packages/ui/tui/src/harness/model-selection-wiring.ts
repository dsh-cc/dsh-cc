/**
 * Model-selection wiring with the phantom-notice sanitizer co-located
 * (effective-model-truth design §5.1): the sanitizer MUST register in the
 * same closure, immediately after `installModelSelection`, so that its
 * later-with-prepend `agent/pre-step` listener becomes the outermost one
 * and can filter the harness's phantom model-selection notice rows while
 * moa overlays the boot selection. A call site using this helper is a
 * co-located pair by construction; the `@dsh-cc/moa/sanitizer` subpath is
 * side-effect-free (no plugin `apply()` path in its import graph).
 */
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { installModelSelectionSanitizer } from '@dsh-cc/moa/sanitizer'

export function installModelSelectionWithSanitizer(agentCtx: Context, selection: ModelSelectionRef): void {
  installModelSelection(agentCtx, selection)
  installModelSelectionSanitizer(agentCtx, selection)
}
