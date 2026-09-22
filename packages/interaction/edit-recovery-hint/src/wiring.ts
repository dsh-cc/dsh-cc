/**
 * Live wiring (design doc Track B): the `tools/post-execute` listener that
 * appends the static recovery hint as an `additionalContexts` entry on the
 * accept decision when an edit fails not-found on a multi-line old_string.
 * Fail-soft all the way — any failure returns the downstream decision
 * unchanged; a throw here would turn the user's tool result into an error
 * (data loss).
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@dsh-cc/tools'
import { isRecoveryCandidate, RECOVERY_HINT, resultTextOf } from './hint.ts'
import { readUserEnabled } from './settings.ts'

/**
 * Runtime editing tool names, lowercase (post-edit-verify EDITING_TOOLS
 * precedent). Only `edit` matters here: the design doc's Write disjunct is
 * vacuous — Write has no `old_string` argument, so isRecoveryCandidate can
 * never match it.
 */
const EDIT_TOOL = 'edit'

/** One-shot UserMessage carrying the hint (sideband — never replaces decision content). */
function hintMessage(): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: RECOVERY_HINT }],
    source: { kind: 'plugin', plugin: 'edit-recovery-hint' },
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver, provided by @deepseek-ai/dsh-app-boot at boot. Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
  }
}

/** Guarded dshHome read (context-crusher index.ts pattern): cordis throws on the property access itself. */
function dshHomeOf(ctx: Context): string | undefined {
  try {
    return ctx.dshHomePath?.()
  } catch {
    return undefined
  }
}

export function registerListener(ctx: Context): void {
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const downstream = await next()
    try {
      return await appendHint(ctx, exec, result, downstream)
    } catch (error: unknown) {
      // Fail-soft invariant of the seam (CCR precedent): a throw here would
      // turn the user's tool result into an error result (data loss).
      ctx.logger.warn(`edit-recovery-hint: degraded to passthrough: ${String(error)}`)
      return downstream
    }
  })
}

async function appendHint(
  ctx: Context,
  exec: ToolExecution,
  result: Readonly<ToolExecutionResult>,
  downstream: PostToolDecision,
): Promise<PostToolDecision> {
  if (exec.name !== EDIT_TOOL) return downstream
  // Value-accept guard: the runtime throws on content+value in one decision,
  // so never compose onto the value variant — passthrough untouched.
  if (downstream.kind !== 'accept' || downstream.value !== undefined) return downstream
  // Advice only on failures; a successful edit needs no recovery.
  if (result.isError !== true) return downstream
  const dshHome = dshHomeOf(ctx)
  if (dshHome === undefined) return downstream
  // Raw user-layer read per use: cheap, hot-reload, project scope invisible.
  if (!(await readUserEnabled(dshHome))) return downstream
  if (!isRecoveryCandidate(exec.arguments, resultTextOf(result, downstream))) return downstream
  return { ...downstream, additionalContexts: [...(downstream.additionalContexts ?? []), hintMessage()] }
}
