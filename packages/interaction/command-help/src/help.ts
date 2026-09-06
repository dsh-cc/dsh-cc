/**
 * Pure `/help` rendering: a sorted command index and a single-command detail
 * view. No cordis imports, so the renderers are unit-testable in isolation.
 * @module @dsh-cc/command-help/help
 */

import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import type { PluginCommandInfo } from './plugins.ts'

/**
 * Render the full command index, sorted by name, merging harness commands
 * with plugin commands. On a (theoretically impossible) name collision the
 * harness side wins and the plugin entry is skipped.
 * @param descriptors - the effective command descriptors for one agent.
 * @param pluginCommands - commands exposed by the optional `ccPlugins` service.
 * @returns a sorted multi-line list of `name — description`; plugin entries
 *   carry a trailing `[plugin: <name>]` marker.
 */
export function formatHelpList(
  descriptors: readonly CommandDescriptor[],
  pluginCommands: readonly PluginCommandInfo[] = [],
): string {
  const known = new Set(descriptors.map(cmd => cmd.name))
  const merged = [
    ...descriptors.map(cmd => ({
      name: cmd.name,
      description: cmd.description,
      plugin: undefined as string | undefined,
    })),
    ...pluginCommands
      .filter(cmd => !known.has(cmd.name))
      .map(cmd => ({ name: cmd.name, description: cmd.description, plugin: cmd.plugin })),
  ]
  const sorted = merged.sort((a, b) => a.name.localeCompare(b.name))
  if (sorted.length === 0) return 'No commands registered.'
  return sorted
    .map(cmd => {
      const marker = cmd.plugin === undefined ? '' : ` [plugin: ${cmd.plugin}]`
      return `/${cmd.name} — ${cmd.description}${marker}`
    })
    .join('\n')
}

/**
 * Render one command's detail, including its input hint when declared.
 * @param descriptors - the effective command descriptors for one agent.
 * @param name - the requested command name without the leading slash.
 * @returns the detail block, or `undefined` when the name is unknown.
 */
export function formatHelpDetail(
  descriptors: readonly CommandDescriptor[],
  name: string,
  pluginCommand?: PluginCommandInfo,
): string | undefined {
  const command = descriptors.find(cmd => cmd.name === name)
  if (command === undefined) {
    if (pluginCommand === undefined) return undefined
    return formatPluginHelpDetail(pluginCommand)
  }
  const lines = [`/${command.name}`, command.description]
  if (command.input !== undefined) lines.push(`usage: /${command.name} ${command.input.hint}`)
  return lines.join('\n')
}

/**
 * Render one plugin command's detail, including its plugin origin and
 * optional argument hint.
 * @param command - the plugin command info.
 * @returns the detail block.
 */
export function formatPluginHelpDetail(command: PluginCommandInfo): string {
  const lines = [`/${command.name}`, command.description, `from plugin: ${command.plugin}`]
  if (command.argumentHint !== undefined) {
    lines.push(`usage: /${command.name} ${command.argumentHint}`)
  }
  return lines.join('\n')
}
