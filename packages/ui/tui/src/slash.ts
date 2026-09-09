/**
 * TUI-local slash parsing. Harness commands still dispatch through
 * `ctx.commands`; these names are owned by the terminal surface.
 * @module @dsh-cc/tui/slash
 */

/** Slash names the TUI handles without calling `ctx.commands`. */
export const LOCAL_SLASH = [
  'quit', 'exit', 'clear', 'new', 'reset', 'tui-help', 'resume', 'model', 'effort', 'agents', 'usage', 'export-md', 'copy', 'provider',
] as const

/** `/provider` subcommands (§4.1) — surfaced as the argument completer hints. */
export const PROVIDER_SUBCOMMANDS = ['list', 'add', 'remove'] as const

export type LocalSlashName = (typeof LOCAL_SLASH)[number]

export interface LocalCommand {
  readonly name: string
  readonly description: string
  readonly argumentHint?: string
}

/**
 * Catalog of TUI-owned slash commands, surfaced via {@link Driver.listCommands}
 * and the composer autocomplete. Descriptions mirror runLocal's behavior so
 * the suggestion list matches what each command actually does.
 */
export const LOCAL_COMMANDS: readonly LocalCommand[] = [
  { name: 'quit', description: 'Exit the TUI session' },
  { name: 'exit', description: 'Exit the TUI session' },
  { name: 'clear', description: 'Start a new conversation (empty context). Previous session stays resumable.' },
  { name: 'new', description: 'Alias of /clear' },
  { name: 'reset', description: 'Alias of /clear' },
  { name: 'tui-help', description: 'Show TUI keyboard and command help' },
  { name: 'resume', description: 'Switch to a resumed session (picker or /resume <id>)', argumentHint: '<sessionId>' },
  { name: 'model', description: 'List or switch the active model', argumentHint: '<n|provider/id>' },
  { name: 'effort', description: 'Set reasoning effort for the current model', argumentHint: '<level|default>' },
  { name: 'agents', description: 'List, inspect, or stop background agents', argumentHint: '[<id>|stop <id>]' },
  { name: 'usage', description: 'Open the live token and context usage panel' },
  {
    name: 'export-md',
    description: 'Export the transcript to a Markdown file',
    argumentHint: '<path>',
  },
  { name: 'copy', description: 'Copy the latest assistant reply to the clipboard' },
  { name: 'provider', description: 'Manage LLM provider routes and API keys', argumentHint: '[list | add <preset-id> | remove <route>]' },
] as const

export type ParsedSlash =
  | { kind: 'local'; name: string; rawInput: string }
  | { kind: 'harness'; line: string }
  | { kind: 'none' }

/**
 * Plugin-command names exposed by the cc-shell `ccPlugins` service in the
 * colon form `plugin:command` (e.g. `codex:review`). The TUI treats them as
 * local commands, so classification must see the live table — but slash.ts is
 * a pure leaf with no service access, so the catalog section (which owns the
 * service lookup) publishes the names here. Duck-typed optional consumption:
 * an empty registry (no ccPlugins service, or none published yet) keeps the
 * pre-plugin behavior untouched.
 */
let pluginSlashNames: ReadonlySet<string> = new Set()

/** Publish the current plugin-command name table (lowercased for matching). */
export function setPluginSlashNames(names: readonly string[]): void {
  pluginSlashNames = new Set(names.map(name => name.toLowerCase()))
}

/**
 * Classify one composer line. Leading slash required; unknown names go to
 * the harness catalog so preset commands (`/permissions`, `/status`, …) work.
 * At submit, a harness-kind line the command registry does not match falls
 * through to a user prompt — user-invocable skills load through that
 * host-side gesture boundary, so a hand-typed `/skill-name` reaches the model
 * the same way a menu pick would.
 * @param line - the raw composer contents.
 */
export function parseSlash(line: string): ParsedSlash {
  const trimmed = line.trim()
  if (!trimmed.startsWith('/')) return { kind: 'none' }
  const body = trimmed.slice(1)
  const space = body.search(/\s/)
  const name = (space === -1 ? body : body.slice(0, space)).toLowerCase()
  const rawInput = space === -1 ? '' : body.slice(space).trim()
  if ((LOCAL_SLASH as readonly string[]).includes(name)) {
    return { kind: 'local', name, rawInput }
  }
  // Plugin commands (colon form, `plugin:command`) dispatch through the
  // ccPlugins service in runLocal. A name NOT in the table keeps the harness
  // fall-through — the skill-injection gesture boundary depends on it, so a
  // colon name must never be hard-classified local on a miss.
  if (pluginSlashNames.has(name)) {
    return { kind: 'local', name, rawInput }
  }
  return { kind: 'harness', line: trimmed }
}
