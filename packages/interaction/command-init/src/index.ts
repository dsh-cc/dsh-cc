/**
 * Human-facing `/init` command: queue a CLAUDE.md initialization for the model
 * by routing a follow-up turn through `invocation.agent.followup`.
 * @module @dsh-cc/command-init
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { initContent } from './init.ts'

export const name = 'command-init'
export const inject = ['commands']

/** Execute `/init`: hand the init instruction to the agent as a model turn. */
function executeInit(invocation: CommandInvocation): CommandResult {
  const message = createUserMessage({
    content: [initContent()],
    source: { kind: 'user' },
  })
  invocation.agent.followup(message)
  return { kind: 'success', text: 'Initializing CLAUDE.md…' }
}

/**
 * Register the `/init` command for every composed command adapter.
 * @param ctx - context carrying the command registry.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'init',
    description: 'analyze this repository and write (or refresh) CLAUDE.md',
    handler: (invocation: CommandInvocation) => executeInit(invocation),
  })
}
