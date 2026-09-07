/**
 * Pure renderers for the `/plugin` management surface: the installed-plugin
 * list, the marketplace list, the frozen §3 success lines, the manage footer,
 * and the help/grammar block. Only shapes data; no I/O, no seams.
 *
 * @module @dsh-cc/command-plugin/render-manage
 */

/** One installed-plugin row (structural subset of the manager's list entry). */
export interface InstalledPluginRow {
  id: string
  version: string
  scope: string
  effectiveEnabled: boolean
  overrideNote?: string
}

/** One marketplace row (structural subset of the manager's marketplace entry). */
export interface MarketplaceListRow {
  name: string
  source: { source: 'directory', path: string } | { source: 'github', repo: string } | { source: 'git', url: string }
}

/** The static security warning appended to remote-source installs. */
export const TRUST_WARNING = 'Note: plugins can add hooks and MCP servers; only install from sources you trust.'

/** Footer appended to the bare `/plugin` mounted view. */
export const MANAGE_FOOTER =
  'Manage: /plugin install|uninstall|enable|disable|update|list · /plugin marketplace add|remove|list|update'

/** Render `/plugin list`: header, blank line, two-space ❯ rows, four-space fields. */
export function formatInstalledList(rows: readonly InstalledPluginRow[]): string {
  if (rows.length === 0) return 'No Claude Code plugins are installed (or none visible from this project).'
  const lines: string[] = ['Installed Claude Code plugins:', '']
  for (const row of rows) {
    lines.push(`  ❯ ${row.id}`)
    lines.push(`    Version: ${row.version}`)
    lines.push(`    Scope: ${row.scope}`)
    lines.push(`    Status: ${row.effectiveEnabled ? '✔ enabled' : '✘ disabled'}`)
    if (row.overrideNote !== undefined) lines.push(`    Overrides: ${row.overrideNote}`)
  }
  return lines.join('\n')
}

/** Render `/plugin marketplace list` with the probed CC source spelling. */
export function formatMarketplaceList(rows: readonly MarketplaceListRow[]): string {
  if (rows.length === 0) return 'No marketplaces are configured.'
  const lines: string[] = ['Configured marketplaces:', '']
  for (const row of rows) {
    lines.push(`  ❯ ${row.name}`)
    const source = row.source
    if (source.source === 'directory') lines.push(`    Source: Directory (${source.path})`)
    else if (source.source === 'github') lines.push(`    Source: GitHub (${source.repo})`)
    else lines.push(`    Source: Git (${source.url})`)
  }
  return lines.join('\n')
}

/** `Installed plugin: <id> (scope: <s>, version: <v>)` */
export function formatInstallResult(result: { id: string, version: string, scope: string }): string {
  return `Installed plugin: ${result.id} (scope: ${result.scope}, version: ${result.version})`
}

/** `Uninstalled plugin: <id> (scope: <s>)` */
export function formatUninstallResult(result: { id: string, scope: string }): string {
  return `Uninstalled plugin: ${result.id} (scope: ${result.scope})`
}

/** `Enabled plugin: <name> (scope: <s>)` / `Disabled plugin: <name> (scope: <s>)` */
export function formatToggleResult(verb: 'enable' | 'disable', result: { id: string, scope: string }): string {
  return `${verb === 'enable' ? 'Enabled' : 'Disabled'} plugin: ${result.id} (scope: ${result.scope})`
}

/** The frozen update strings: changed-version and up-to-date forms. */
export function formatUpdateResult(result:
  | { upToDate: true, id: string, version: string, scope: string }
  | { upToDate: false, id: string, fromVersion: string, toVersion: string, scope: string }): string {
  if (result.upToDate) return `Plugin "${result.id}" is already up to date (scope: ${result.scope}).`
  return `Plugin "${result.id}" updated from ${result.fromVersion} to ${result.toVersion} for scope ${result.scope}. Restart to apply changes (or /reload-plugins).`
}

/** `Added marketplace: <name> (<source-kind>, declared in <s> settings)` */
export function formatMarketplaceAdded(result: { name: string, sourceKind: string, scope: string }): string {
  return `Added marketplace: ${result.name} (${result.sourceKind}, declared in ${result.scope} settings)`
}

/** `Removed marketplace: <name> (also uninstalled <k> plugin installation(s))` */
export function formatMarketplaceRemoved(result: { name: string, removedPlugins: readonly string[] }): string {
  return `Removed marketplace: ${result.name} (also uninstalled ${result.removedPlugins.length} plugin installation(s))`
}

/** `Updated marketplace: <name>` for one; `Updated <k> marketplaces.` for many (or zero). */
export function formatMarketplacesUpdated(names: readonly string[]): string {
  if (names.length === 1) return `Updated marketplace: ${names[0]}`
  return `Updated ${names.length} marketplaces.`
}

/** The `/plugin` grammar block shown for unknown subcommands. */
export function formatPluginHelp(): string {
  return [
    'Usage: /plugin <subcommand>',
    '',
    '  /plugin                                   mounted-plugins view',
    '  /plugin list [--enabled|--disabled]',
    '  /plugin install <plugin[@mkt]> [--scope user|project|local]',
    '  /plugin uninstall <plugin[@mkt]> [--scope user|project|local]',
    '  /plugin enable <plugin[@mkt]> [--scope user|project|local]',
    '  /plugin disable <plugin[@mkt]> [--scope user|project|local]',
    '  /plugin update <plugin[@mkt]> [--scope user|project|local]',
    '  /plugin marketplace list',
    '  /plugin marketplace add <source> [--scope user|project|local]',
    '  /plugin marketplace remove <name>',
    '  /plugin marketplace update [name]',
    '  /plugin help                              show this help',
  ].join('\n')
}
