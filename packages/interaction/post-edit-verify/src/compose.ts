/**
 * Post-execute accept composition (design doc §2/§3.3). Pure functions that
 * append the verify block to the downstream accept decision without ever
 * triggering the runtime's content+value invariant (runtime-results throws
 * when a decision carries both), and the verify block text builder.
 *
 * @module
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecutionResult } from '@dsh-cc/tools'

/** Outcome of a compose attempt: the decision to return upstream, and whether appending was skipped. */
export interface ComposeOutcome {
  decision: PostToolDecision
  /** True when the downstream decision was passed through untouched (value-accept or block). */
  skipped: boolean
}

/**
 * Compose a verify block onto the downstream decision.
 *
 * - content-bearing accept → append to its content;
 * - bare accept (no content) → fall back to the waterfall `result.content`,
 *   where the edit tool's own output lives, and append;
 * - value-accept → passthrough untouched, `skipped: true` (the runtime
 *   throws on content+value; a throwing listener turns the edit into isError);
 * - block → passthrough untouched.
 */
export function composeVerifyBlock(
  downstream: PostToolDecision,
  result: Readonly<ToolExecutionResult>,
  verifyBlock: ContentBlock,
): ComposeOutcome {
  if (downstream.kind !== 'accept' || downstream.value !== undefined) {
    return { decision: downstream, skipped: true }
  }
  const base = downstream.content ?? result.content
  return {
    decision: {
      kind: 'accept',
      content: [...base, verifyBlock],
      ...(downstream.additionalContexts === undefined
        ? {}
        : { additionalContexts: downstream.additionalContexts }),
    },
    skipped: false,
  }
}

/**
 * Build the appended verify block (doc §3.3): exit 0 is a nearly-free
 * one-liner unless `verbose`; non-zero carries a header plus the kept output.
 */
export function buildVerifyBlock(
  command: string,
  exitCode: number,
  durationMs: number,
  output: string,
  verbose: boolean,
): ContentBlock {
  const kept = output.trim().length > 0 ? output : 'no output'
  if (exitCode === 0 && !verbose) {
    return { type: 'text', text: `[auto-verify] ${command} — ok (${durationMs}ms)` }
  }
  return { type: 'text', text: `[auto-verify] ${command} — exit ${exitCode} (${durationMs}ms)\n${kept}` }
}
