/**
 * R9 settled-wake copy rewrite (dsh-cc-side; the harness `notifySettlement`
 * surface is not editable — same mechanism class as `one-shot-notice.ts`): a
 * pre-step waterfall listener that appends the arm-time grace clause to every
 * delivered `subagent-settled` wake whose sender is a grace-registered child.
 * The clause carries the window AND the absolute local expiry from the
 * ARMED entry (arming at `subagent/end` can precede delivery), so the model
 * holding the wake knows the exact deadline. A `0` override renders
 * "auto-release disabled"; an unregistered sender is left untouched.
 *
 * @module @dsh-cc/subagent-task/grace-settled-notice
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { graceWindowClause } from './grace-window.ts'
import { isSubagentSettledNotice } from './suppress-settled.ts'

/**
 * Mount the `agent/pre-step` settled-wake clause listener.
 * @param ctx - the plug context.
 * @returns an unmount callback.
 */
export function mountGraceSettledNotice(ctx: Context): () => void {
  return ctx.on('agent/pre-step', async (_env, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    let changed = false
    const messages = decision.messages.map(message => {
      const settled = message as { source?: { kind?: string; senderSessionId?: string } }
      if (!isSubagentSettledNotice(settled)) return message
      const sender = settled.source?.senderSessionId
      const clause = sender !== undefined ? graceWindowClause(String(sender)) : ''
      if (clause === '') return message
      const content = (message as { content?: unknown }).content
      if (!Array.isArray(content)) return message
      changed = true
      return {
        ...message,
        content: [...content, { type: 'text', text: clause }],
      } as typeof message
    })
    return changed ? { ...decision, messages } : decision
  })
}
