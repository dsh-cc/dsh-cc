/**
 * Workspace-instruction strip for delegated Task children: a waterfall
 * listener that drops harness `agent-instructions` messages (the CLAUDE.md
 * / AGENTS.md baseline) so named children keep their own agent-file persona
 * instead of also loading the parent's workspace instructions.
 *
 * @module @dsh-cc/subagent-task/strip-instructions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'

/**
 * Whether an agent is a delegated Task child (`delegationDepth > 0`).
 * Fails closed: a throw from reading the depth treats the agent as a child.
 * @param agent - the agent to classify.
 */
export function isDelegated(agent: Agent): boolean {
  try {
    return delegationDepthOf(agent) !== 0
  } catch {
    return true
  }
}

/**
 * Whether a message was injected by the harness `agent-instructions`
 * plugin (workspace CLAUDE.md / AGENTS.md baseline). Duck-typed on
 * `source.kind` so the strip never imports the plugin.
 * @param message - a candidate message with an optional source.
 */
export function isAgentInstructions(message: { source?: { kind?: string } }): boolean {
  return message.source?.kind === 'agent-instructions'
}

/**
 * Remove every pending `agent-instructions` message from the inbox's
 * next-step queue. Copies the queue before iterating because `remove`
 * mutates it. A missing inbox (duck-typed test agents) is a no-op.
 * @param agent - the agent whose inbox is drained.
 */
function drainInbox(agent: Agent): void {
  const inbox = agent.inbox
  if (inbox === undefined) return
  for (const message of [...inbox.nextStep]) {
    if (!isAgentInstructions(message)) continue
    inbox.remove(message.id)
  }
}

/**
 * Mount the `agent/pre-step` listener. After letting the harness
 * `agent-instructions` plugin inject, delegated children lose every
 * `agent-instructions` message both from the enter batch and from the
 * pending inbox; top-level agents pass through untouched.
 *
 * Registered with `prepend`: the cordis waterfall dispatches listeners
 * outermost-first in registration order, and the cc preset mounts
 * `agent-instructions` rows BEFORE `cc-subagent-task`, so an appended
 * strip would sit INSIDE the injector — the injector splices the
 * baseline into the enter batch during unwind, after the inner strip
 * already ran, and the strip would never see it. Prepending keeps the
 * strip outermost so its post-`next()` filter sees the injector's
 * output. (Same mechanism `tool-append-order` documents for
 * `system-prompt/assemble`.)
 * @param ctx - the plug context.
 * @returns an unmount callback.
 */
export function mountStripWorkspaceInstructions(ctx: Context): () => void {
  return ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (!isDelegated(agent)) return decision
    drainInbox(agent)
    if (decision.kind !== 'enter') return decision
    return { kind: 'enter', messages: decision.messages.filter(msg => !isAgentInstructions(msg)) }
  }, { prepend: true })
}
