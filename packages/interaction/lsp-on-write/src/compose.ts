/**
 * Post-execute accept composition (design doc §4.5). Pure function that
 * appends the `[lsp]` block to the downstream accept decision without ever
 * triggering the runtime's content+value invariant (post-edit-verify
 * compose.ts precedent).
 *
 * @module
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecutionResult } from '@dsh-cc/tools'

/**
 * Compose the `[lsp]` block onto the downstream decision.
 *
 * - content-bearing accept → append to its content;
 * - bare accept (no content) → fall back to the waterfall `result.content`;
 * - value-accept / block / passthrough → downstream untouched (the runtime
 *   throws on content+value co-presence).
 */
export function composeLspBlock(
  downstream: PostToolDecision,
  result: Readonly<ToolExecutionResult>,
  lspBlock: ContentBlock,
): PostToolDecision {
  if (downstream.kind !== 'accept' || downstream.value !== undefined) return downstream
  const base = downstream.content ?? result.content
  return {
    kind: 'accept',
    content: [...base, lspBlock],
    ...(downstream.additionalContexts === undefined
      ? {}
      : { additionalContexts: downstream.additionalContexts }),
  }
}
