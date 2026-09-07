/**
 * Human-facing `/help` command: lists every registered slash command or shows
 * the detail for one named command, including its input hint.
 * @module @dsh-cc/command-help
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { helpable } from '@dsh-cc/command-usage'
import { formatHelpDetail, formatHelpList } from './help.ts'
import { findPluginCommand, listPluginCommands } from './plugins.ts'

export { formatPluginHelpDetail } from './help.ts'
export type { PluginCommandInfo } from './plugins.ts'
export { findPluginCommand, listPluginCommands } from './plugins.ts'

export const name = 'command-help'
export const inject = ['commands']

/** Trailing guidance appended to the bare `/help` command index. */
const HELP_ARG_TIP = 'Tip: every command accepts a trailing `help` argument for usage details.'

/** Execute `/help [cmd]`. */
function executeHelp(ctx: Context, invocation: CommandInvocation): CommandResult {
  const descriptors = ctx.commands.list(invocation.agent)
  const pluginCommands = listPluginCommands(ctx)
  const token = invocation.rawInput.trim()
  if (token.length === 0) {
    return { kind: 'success', text: `${formatHelpList(descriptors, pluginCommands)}\n${HELP_ARG_TIP}` }
  }
  const lowered = token.toLowerCase()
  // Colon-form names (e.g. `codex:review`) cannot exist in the harness
  // registry; they resolve against the plugin command table instead.
  const pluginHit = findPluginCommand(ctx, lowered)
  const detail = formatHelpDetail(descriptors, lowered, pluginHit)
  if (detail === undefined) {
    return { kind: 'success', text: `Unknown command /${token}. Try /help for a list.` }
  }
  return { kind: 'success', text: detail }
}

/**
 * Register the `/help` command for every composed command adapter.
 * @param ctx - context carrying the command registry.
 */
export function apply(ctx: Context): void {
  ctx.commands.register(helpable({
    name: 'help',
    description: 'list all slash commands, or show details for one (e.g. /help memory)',
    input: { hint: '[command]' },
    handler: (invocation: CommandInvocation) => executeHelp(ctx, invocation),
  }, {
    notes: ['Tip: every command accepts a trailing `help` argument.'],
  }))
}
