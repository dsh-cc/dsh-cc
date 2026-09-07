/**
 * Pure argv parser for the `/plugin` command grammar (plan §3):
 *
 * ```
 * /plugin                                   # bare → mounted view
 * /plugin list [--enabled|--disabled]
 * /plugin install|uninstall|enable|disable|update <plugin[@mkt]> [--scope user|project|local]
 * /plugin marketplace list|add <source> [--scope …]|remove <name>|update [name]
 * ```
 *
 * Unknown subcommands route to the help block; malformed forms and bad flag
 * values produce a parse error whose message is a one-line `Usage:` string
 * naming the exact expected form. No I/O, no imports — fully table-testable.
 *
 * @module @dsh-cc/command-plugin/subcommands
 */

/** Verb dispatched to the manage handlers (marketplace verbs are prefixed). */
export type PluginVerb =
  | 'list'
  | 'install'
  | 'uninstall'
  | 'enable'
  | 'disable'
  | 'update'
  | 'marketplace-list'
  | 'marketplace-add'
  | 'marketplace-remove'
  | 'marketplace-update'

/** A fully-validated manage command: what to run, with which arguments. */
export interface ParsedPluginCommand {
  verb: PluginVerb
  /** Plugin id, marketplace source, or marketplace name — per verb. */
  arg?: string
  /** Validated `--scope` value (`user` | `project` | `local`). */
  scope?: string
  /** `--enabled` / `--disabled` filter for `list`. */
  filter?: 'enabled' | 'disabled'
}

/** Parser outcome for one `/plugin` invocation. */
export type ParseOutcome =
  | { kind: 'mounted' }
  | { kind: 'help' }
  | { kind: 'parse-error'; message: string }
  | { kind: 'command'; command: ParsedPluginCommand }

/** One-line `Usage:` strings per grammar form (parse-error messages). */
const USAGE = {
  list: 'Usage: /plugin list [--enabled|--disabled]',
  plugin: 'Usage: /plugin <verb> <plugin[@mkt]> [--scope user|project|local]',
  install: 'Usage: /plugin install <plugin[@mkt]> [--scope user|project|local]',
  uninstall: 'Usage: /plugin uninstall <plugin[@mkt]> [--scope user|project|local]',
  enable: 'Usage: /plugin enable <plugin[@mkt]> [--scope user|project|local]',
  disable: 'Usage: /plugin disable <plugin[@mkt]> [--scope user|project|local]',
  update: 'Usage: /plugin update <plugin[@mkt]> [--scope user|project|local]',
  marketplace: 'Usage: /plugin marketplace list|add|remove|update',
  'marketplace-list': 'Usage: /plugin marketplace list',
  'marketplace-add': 'Usage: /plugin marketplace add <source> [--scope user|project|local]',
  'marketplace-remove': 'Usage: /plugin marketplace remove <name>',
  'marketplace-update': 'Usage: /plugin marketplace update [name]',
} as const

const SCOPES: readonly string[] = ['user', 'project', 'local']

function parseError(message: string): ParseOutcome {
  return { kind: 'parse-error', message }
}

/** Consume `--scope user` / `--scope=user` starting at `index`; returns the scope and the next index. */
function readScopeFlag(
  args: readonly string[],
  index: number,
  usage: string,
): { scope: string; next: number } | ParseOutcome {
  const token = args[index]!
  const inline = token.startsWith('--scope=')
  const value = inline ? token.slice('--scope='.length) : args[index + 1]
  const next = inline ? index + 1 : index + 2
  if (value === undefined || !SCOPES.includes(value)) return parseError(usage)
  return { scope: value, next }
}

function parsePluginVerb(verb: 'install' | 'uninstall' | 'enable' | 'disable' | 'update', args: readonly string[]): ParseOutcome {
  const usage = USAGE[verb]
  const positional: string[] = []
  let scope: string | undefined
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index]!
    if (token === '--scope') {
      const read = readScopeFlag(args, index, usage)
      if ('kind' in read) return read
      scope = read.scope
      index = read.next - 1
      continue
    }
    if (token.startsWith('--scope=')) {
      const read = readScopeFlag(args, index, usage)
      if ('kind' in read) return read
      scope = read.scope
      index = read.next - 1
      continue
    }
    if (token.startsWith('--')) return parseError(usage)
    positional.push(token)
  }
  if (positional.length !== 1) return parseError(usage)
  const command: ParsedPluginCommand = { verb, arg: positional[0]! }
  if (scope !== undefined) command.scope = scope
  return { kind: 'command', command }
}

function parseMarketplace(args: readonly string[]): ParseOutcome {
  const sub = args[1]
  if (sub === undefined) return { kind: 'help' }
  switch (sub) {
    case 'list':
      if (args.length !== 2) return parseError(USAGE['marketplace-list'])
      return { kind: 'command', command: { verb: 'marketplace-list' } }
    case 'add': {
      if (args.length < 3) return parseError(USAGE['marketplace-add'])
      const positional: string[] = []
      let scope: string | undefined
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index]!
        if (token === '--scope' || token.startsWith('--scope=')) {
          const read = readScopeFlag(args, index, USAGE['marketplace-add'])
          if ('kind' in read) return read
          scope = read.scope
          index = read.next - 1
          continue
        }
        if (token.startsWith('--')) return parseError(USAGE['marketplace-add'])
        positional.push(token)
      }
      if (positional.length !== 1) return parseError(USAGE['marketplace-add'])
      const command: ParsedPluginCommand = { verb: 'marketplace-add', arg: positional[0]! }
      if (scope !== undefined) command.scope = scope
      return { kind: 'command', command }
    }
    case 'remove':
      if (args.length !== 3) return parseError(USAGE['marketplace-remove'])
      return { kind: 'command', command: { verb: 'marketplace-remove', arg: args[2]! } }
    case 'update':
      if (args.length > 3) return parseError(USAGE['marketplace-update'])
      return args.length === 3
        ? { kind: 'command', command: { verb: 'marketplace-update', arg: args[2]! } }
        : { kind: 'command', command: { verb: 'marketplace-update' } }
    default:
      return { kind: 'help' }
  }
}

/**
 * Parse raw `/plugin` argument tokens (already split on whitespace, command
 * name excluded): `parsePluginArgv(['install', 'foo'])` for `/plugin install foo`.
 */
export function parsePluginArgv(args: readonly string[]): ParseOutcome {
  const head = args[0]
  if (head === undefined) return { kind: 'mounted' }
  switch (head) {
    case 'list': {
      if (args.length > 2) return parseError(USAGE.list)
      const flag = args[1]
      if (flag === undefined) return { kind: 'command', command: { verb: 'list' } }
      if (flag === '--enabled' || flag === '--disabled') {
        return { kind: 'command', command: { verb: 'list', filter: flag === '--enabled' ? 'enabled' : 'disabled' } }
      }
      return parseError(USAGE.list)
    }
    case 'install':
    case 'uninstall':
    case 'enable':
    case 'disable':
    case 'update':
      return parsePluginVerb(head, args)
    case 'marketplace':
      return parseMarketplace(args)
    default:
      return { kind: 'help' }
  }
}
