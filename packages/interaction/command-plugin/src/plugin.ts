/**
 * Pure `/plugin` and `/reload-plugins` rendering helpers: plugin listing and
 * rescan-summary formatting. The ccPlugins seam lives in the host composition,
 * so these functions only shape already-loaded data and are unit-testable
 * without mounting the glue.
 * @module @dsh-cc/command-plugin/plugin
 */

/** One mounted plugin's public summary from the ccPlugins seam. */
export interface CcPluginSummary {
  /** The plugin's manifest name. */
  name: string
  /** The plugin root directory holding `plugin.json`. */
  root: string
  /** Per-component load outcome counts. */
  components: readonly CcComponentResult[]
}

/** Per-component load outcome counts for one plugin. */
export interface CcComponentResult {
  /** Component kind: commands, agents, skills, hooks, mcpServers, settings. */
  kind: string
  /** Components successfully mounted. */
  loaded: number
  /** Components skipped because their host seam was absent or disallowed. */
  skipped: number
  /** Components that failed to mount. */
  failed: number
}

/** One failure surfaced from a rescan (or a mount dispose). */
export interface CcPluginRescanError {
  /** The plugin root that failed. */
  root: string
  /** The manifest name, when known. */
  name?: string
  /** The error message. */
  error: string
}

/** Render one plugin's component tallies as `kind loaded/skipped/failed`. */
export function formatComponentTallies(components: readonly CcComponentResult[]): string {
  if (components.length === 0) return '(no components)'
  return components.map(component => {
    const nonTrivial = component.failed > 0 || component.skipped > 0
    const suffix = nonTrivial ? ` (${component.skipped} skipped, ${component.failed} failed)` : ''
    return `${component.kind}: ${component.loaded}${suffix}`
  }).join(', ')
}

/**
 * Render the mounted-plugin index.
 * @param plugins - the mounted plugin summaries, already enumerated.
 * @returns the list report, or a placeholder when none are mounted.
 */
export function formatPluginList(plugins: readonly CcPluginSummary[]): string {
  if (plugins.length === 0) return 'No Claude Code plugins are mounted.'
  const lines: string[] = ['Mounted Claude Code plugins:']
  for (const plugin of plugins) {
    lines.push(`- ${plugin.name}`)
    lines.push(`  root: ${plugin.root}`)
    lines.push(`  components: ${formatComponentTallies(plugin.components)}`)
  }
  return lines.join('\n')
}

/**
 * Render the outcome of a `/reload-plugins` rescan.
 * @param plugins - the freshly mounted plugins after rescan.
 * @param errors - per-root failures collected during the rescan.
 * @returns the remount summary, including per-plugin errors when any occurred.
 */
export function formatReloadSummary(
  plugins: readonly CcPluginSummary[],
  errors: readonly CcPluginRescanError[],
): string {
  const header = `Reloaded ${plugins.length} Claude Code plugin${plugins.length === 1 ? '' : 's'}.`
  const lines: string[] = [header]
  for (const plugin of plugins) {
    lines.push(`- ${plugin.name} (${plugin.root})`)
  }
  if (errors.length === 0) return lines.join('\n')
  lines.push(`${errors.length} plugin root${errors.length === 1 ? '' : 's'} failed to remount:`)
  for (const error of errors) {
    const label = error.name === undefined ? error.root : `${error.name} (${error.root})`
    lines.push(`- ${label}: ${error.error}`)
  }
  return lines.join('\n')
}
