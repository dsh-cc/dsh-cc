/**
 * Shared trailing-`help` argument support for slash commands.
 * @module @dsh-cc/command-usage
 */

import type {
  CommandDefinition,
  CommandDescriptor,
  CommandInvocation,
  CommandResult,
} from '@deepseek-ai/dsh-commands'

/** Whether the invocation's trailing argument is a help request. */
export function isHelpRequest(rawInput: string): boolean {
  const first = rawInput.trim().split(/\s+/u)[0]
  if (first === undefined || first === '') return false
  const token = first.toLowerCase()
  return token === 'help' || token === '-h' || token === '--help'
}

/** One human-readable subcommand row. */
export interface CommandHelpEntry {
  /** The subcommand word as typed after the command name. */
  readonly word: string
  /** Optional placeholder grammar shown after the word. */
  readonly args?: string
  /** One-line summary of what the subcommand does. */
  readonly summary: string
}

/** Everything needed to render one command's help text. */
export interface CommandHelpSpec {
  /** Lowercase command name without the leading slash. */
  readonly name: string
  /** Human-readable summary of the command. */
  readonly description: string
  /** Usage line(s) beyond the bare `/<name>` form. */
  readonly usage?: string | readonly string[] | undefined
  /** Optional subcommand rows. */
  readonly subcommands?: readonly CommandHelpEntry[] | undefined
  /** Optional one-line notes rendered last. */
  readonly notes?: readonly string[] | undefined
}

/** Usage lines after the mandatory bare `/<name>` form. */
function usageLines(spec: CommandHelpSpec): string[] {
  const usage = spec.usage
  if (usage === undefined) return []
  return (typeof usage === 'string' ? [usage] : [...usage]).map(entry => `  /${spec.name} ${entry}`)
}

/** Summary-column padding for one subcommand row. */
function subcommandLines(spec: CommandHelpSpec): string[] {
  const entries = spec.subcommands
  if (entries === undefined || entries.length === 0) return []
  const rows = entries.map(entry => ({
    left: `${entry.word}${entry.args === undefined ? '' : ` ${entry.args}`}`,
    summary: entry.summary,
  }))
  const width = Math.max(...rows.map(row => row.left.length))
  return rows.map(row => `  ${row.left.padEnd(width)}  ${row.summary}`)
}

/** Render the canonical plain-text help layout for one command. */
export function formatCommandHelp(spec: CommandHelpSpec): string {
  const lines: string[] = [
    `/${spec.name} — ${spec.description}`,
    'Usage:',
    `  /${spec.name}`,
    ...usageLines(spec),
  ]
  const subcommands = subcommandLines(spec)
  if (subcommands.length > 0) lines.push('Subcommands:', ...subcommands)
  if (spec.notes !== undefined && spec.notes.length > 0) {
    lines.push('Notes:', ...spec.notes.map(note => `  ${note}`))
  }
  return lines.join('\n')
}

/** Extras layered onto a definition's own metadata when rendering help. */
export interface HelpableExtras {
  /** Overrides the input hint as the derived usage line(s). */
  readonly usage?: string | readonly string[]
  /** Subcommand rows to render. */
  readonly subcommands?: readonly CommandHelpEntry[]
  /** One-line notes to render. */
  readonly notes?: readonly string[]
}

/**
 * Wrap a command definition so any trailing `help`, `-h`, or `--help`
 * argument is answered with its formatted help text instead of a model turn.
 * The original definition is never mutated.
 */
export function helpable(def: CommandDescriptor & Pick<CommandDefinition, 'handler'>, extras?: HelpableExtras): CommandDefinition {
  const wrapped: CommandDefinition = {
    name: def.name,
    description: def.description,
    ...(def.input !== undefined ? { input: def.input } : {}),
    handler(invocation: CommandInvocation): CommandResult | Promise<CommandResult> {
      if (isHelpRequest(invocation.rawInput)) {
        const usage = extras?.usage ?? def.input?.hint
        return {
          kind: 'success',
          text: formatCommandHelp({
            name: def.name,
            description: def.description,
            usage,
            subcommands: extras?.subcommands,
            notes: extras?.notes,
          }),
        }
      }
      return def.handler(invocation)
    },
  }
  return wrapped
}
