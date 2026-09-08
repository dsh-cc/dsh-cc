/**
 * Duplicate-notice suppression for inline-collected subagent epochs
 * (`docs/plans/2026-09-05-epoch-collector-dsh-cc.md` §5): a pre-step
 * waterfall listener that DROPs pending `subagent-settled` messages whose
 * `senderSessionId` is in the pop-once "collected" set, so a collected
 * epoch's settlement account lives only in the tool result and never also
 * wakes the parent. A promoted child is simply removed from the set — its
 * notice flows normally.
 *
 * Registration mirrors `mountStripWorkspaceInstructions` (same file's
 * `prepend` ordering rationale): the cc preset mounts `agent-instructions`
 * rows BEFORE `cc-subagent-task`, and waterfall listeners dispatch
 * outermost-first in registration order, so the strip is prepended to stay
 * outermost. This listener is prepended too, which places it outermost of
 * the two — harmless: the two filters are independent (one drops
 * `agent-instructions`, the other `subagent-settled`).
 *
 * Unlike the strip, this listener is NOT scoped by `isDelegated`: the
 * `subagent-settled` notice arrives in the PARENT's inbox, and the parent is
 * typically a top-level agent. The filter is safe to apply to every agent —
 * it only drops `subagent-settled` messages whose sender is in the collected
 * set, and pop-once semantics make double consultation impossible.
 *
 * @module @dsh-cc/subagent-task/suppress-settled
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  isCollectedForSuppression,
  releaseCollectedForSuppression,
} from './epoch-collector.ts'

/**
 * Whether a message is a harness settlement notice. Duck-typed on
 * `source.kind` so the filter never imports the continuation plugin.
 * @param message - a candidate message with an optional source.
 */
export function isSubagentSettledNotice(message: {
  source?: { kind?: string; senderSessionId?: string }
}): boolean {
  return (message.source as { kind?: string } | undefined)?.kind === 'subagent-settled'
}

/** Whether a settled notice's sender is currently marked collected. */
function isMarked(message: { source?: { kind?: string; senderSessionId?: string } }): boolean {
  const sender = message.source?.senderSessionId
  return sender !== undefined && isCollectedForSuppression(String(sender))
}

/**
 * Remove every pending settlement notice of a collected child from the
 * inbox's next-step queue, popping the collected entry. Copies the queue
 * before iterating because `remove` mutates it. A missing inbox
 * (duck-typed test agents) is a no-op.
 */
function drainInbox(agent: Agent): void {
  const inbox = agent.inbox as
    | { nextStep?: readonly { id: string; source?: { kind?: string; senderSessionId?: string } }[]; remove(id: string): boolean }
    | undefined
  if (inbox === undefined || inbox.nextStep === undefined) return
  for (const message of [...inbox.nextStep]) {
    if (!isSubagentSettledNotice(message) || !isMarked(message)) continue
    releaseCollectedForSuppression(String(message.source?.senderSessionId))
    inbox.remove(message.id)
  }
}

/**
 * Mount the `agent/pre-step` suppression listener. See the module doc for
 * the ordering and scoping rationale.
 * @param ctx - the plug context.
 * @returns an unmount callback.
 */
export function mountSettledNoticeSuppression(ctx: Context): () => void {
  return ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    const decision = await next()
    drainInbox(agent)
    if (decision.kind !== 'enter') return decision
    return {
      kind: 'enter',
      messages: decision.messages.filter(msg => {
        if (!isSubagentSettledNotice(msg as never) || !isMarked(msg as never)) return true
        releaseCollectedForSuppression(String((msg.source as { senderSessionId?: string } | undefined)?.senderSessionId))
        return false
      }),
    }
  }, { prepend: true })
}
