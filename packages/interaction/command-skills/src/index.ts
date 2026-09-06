/**
 * Human-facing `/skills` command: lists every available skill with its
 * description, source, and invocation policy.
 * @module @dsh-cc/command-skills
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { formatSkills } from './skills.ts'

export const name = 'command-skills'
export const inject = ['commands', 'skills']

/** Execute `/skills`. Pass the invoking agent as `scope` so preset-layer providers are visible. */
async function executeSkills(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const skills = await ctx.skills.list({
    cwd: invocation.agent.session.header.cwd,
    scope: invocation.agent,
  })
  return { kind: 'success', text: formatSkills(skills) }
}

/**
 * Register the `/skills` command for every composed command adapter.
 * @param ctx - context carrying the command registry and skill registry.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'skills',
    description: 'list available skills with their invocation policy',
    handler: (invocation: CommandInvocation) => executeSkills(ctx, invocation),
  })
}
