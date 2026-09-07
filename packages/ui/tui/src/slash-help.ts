/**
 * Help text for the TUI-local slash commands, rendered through
 * `formatCommandHelp` so every entry follows the shared canonical layout.
 * Descriptions are sourced from LOCAL_COMMANDS so autocomplete and help
 * always agree; usage/subcommand rows mirror the real argument parsers
 * (model-catalog.ts, effort-catalog.ts, driver-agents.ts, provider-read.ts).
 * @module @dsh-cc/tui/slash-help
 */

import { formatCommandHelp, type CommandHelpSpec } from '@dsh-cc/command-usage'
import { LOCAL_COMMANDS, LOCAL_SLASH } from './slash.ts'

/** Authored help extras per local slash name (description comes from LOCAL_COMMANDS). */
const LOCAL_HELP_SPECS: Readonly<Record<string, Omit<CommandHelpSpec, 'name' | 'description'>>> = {
  quit: {},
  exit: { notes: ['Alias of /quit.'] },
  clear: {},
  new: { notes: ['Alias of /clear.'] },
  reset: { notes: ['Alias of /clear.'] },
  'tui-help': {},
  resume: {
    usage: ['<sessionId>', '(no argument — open the session switcher)'],
  },
  model: {
    usage: ['<n|provider/id>', '(no argument — open the model picker)'],
    notes: [
      '<n> is the 1-based catalog index; provider/id is an exact provider/model pair; a bare id resolves only when it is unique.',
    ],
  },
  effort: {
    usage: ['<level|default>', '(no argument — open the effort picker)'],
    notes: [
      'default is a reserved keyword: it resets to the provider default and wins even over a level literally named "default".',
    ],
  },
  agents: {
    usage: ['[<id>|stop <id>]', '(no argument — list background agents)'],
    notes: ['<id> shows one agent\'s detail; stop <id> interrupts a running agent.'],
  },
  cost: {},
  usage: {},
  'export-md': {
    usage: ['<path>', '(no argument — write to the default export directory)'],
  },
  copy: {},
  provider: {
    usage: ['[list | add <preset-id> | remove <route>]', '(no argument — open the provider panel)'],
  },
}

/** One rendered help text per LOCAL_SLASH name. */
export const LOCAL_HELP: Readonly<Record<string, string>> = Object.fromEntries(
  LOCAL_SLASH.map((name) => {
    const command = LOCAL_COMMANDS.find(entry => entry.name === name)
    const spec = LOCAL_HELP_SPECS[name]
    return [name, formatCommandHelp({
      name,
      description: command?.description ?? '',
      ...spec,
    })]
  }),
)

/** Rendered help text for one local slash name, or undefined when unknown. */
export function localHelpFor(name: string): string | undefined {
  return LOCAL_HELP[name]
}
