/**
 * Typed errors for the plugin manager, carrying the exact strings from the
 * plan §3 error catalog (the S1 slice covers malformed state files; later
 * slices add their own codes to this catalog).
 *
 * @module @dsh-cc/plugin-manager/errors
 */

export type PluginManagerErrorCode =
  | 'PLUGIN_STATE_MALFORMED'
  | 'UNKNOWN_PLUGIN'
  | 'AMBIGUOUS_PLUGIN_NAME'
  | 'PLUGIN_NOT_INSTALLED'
  | 'AMBIGUOUS_PLUGIN_SCOPES'
  | 'UNKNOWN_SCOPE'
  | 'UNKNOWN_MARKETPLACE'
  | 'MARKETPLACE_CONFLICT'
  | 'MARKETPLACE_BAD_SOURCE'
  | 'MARKETPLACE_MANIFEST_MISSING'
  | 'MARKETPLACE_PLUGIN_NOT_DECLARED'
  | 'PLUGIN_SOURCE_UNSUPPORTED'
  | 'PLUGIN_ALREADY_INSTALLED'
  | 'PLUGIN_ENABLED_AT_PROJECT'
  | 'GIT_FAILED'
  | 'PLUGIN_MANAGER_ERROR'

/**
 * Base error: a stable machine-readable `code` plus the exact human message
 * (the §3 catalog strings) that commands render verbatim.
 */
export class PluginManagerError extends Error {
  readonly code: PluginManagerErrorCode

  constructor(code: PluginManagerErrorCode, message: string) {
    super(message)
    this.name = 'PluginManagerError'
    this.code = code
  }
}

/** `State file <path> is malformed JSON: <detail>` — never silently rewritten. */
export function malformedStateFile(file: string, detail: string): PluginManagerError {
  return new PluginManagerError('PLUGIN_STATE_MALFORMED', `State file ${file} is malformed JSON: ${detail}`)
}

/** `Unknown plugin "<arg>". Installed: <id1>, <id2>` (or `…none` when empty). */
export function unknownPlugin(arg: string, installedKeys: readonly string[]): PluginManagerError {
  const installed = installedKeys.length === 0 ? 'none' : [...installedKeys].sort().join(', ')
  return new PluginManagerError('UNKNOWN_PLUGIN', `Unknown plugin "${arg}". Installed: ${installed}`)
}

/** `Plugin name "<name>" is ambiguous: <id1>, <id2>. Use the full <name>@<marketplace> id.` */
export function ambiguousPluginName(name: string, matches: readonly string[]): PluginManagerError {
  const ids = [...matches].sort().join(', ')
  return new PluginManagerError(
    'AMBIGUOUS_PLUGIN_NAME',
    `Plugin name "${name}" is ambiguous: ${ids}. Use the full <name>@<marketplace> id.`,
  )
}

/** `Plugin "<id>" is not installed.` */
export function pluginNotInstalled(id: string): PluginManagerError {
  return new PluginManagerError('PLUGIN_NOT_INSTALLED', `Plugin "${id}" is not installed.`)
}

/** `Plugin "<id>" is installed at multiple scopes (<s1>, <s2>); pass --scope.` */
export function ambiguousPluginScopes(id: string, scopes: readonly string[]): PluginManagerError {
  return new PluginManagerError(
    'AMBIGUOUS_PLUGIN_SCOPES',
    `Plugin "${id}" is installed at multiple scopes (${scopes.join(', ')}); pass --scope.`,
  )
}

/** `Unknown scope "<s>". Expected user, project, or local.` */
export function unknownScope(scope: string): PluginManagerError {
  return new PluginManagerError('UNKNOWN_SCOPE', `Unknown scope "${scope}". Expected user, project, or local.`)
}

/** `Unknown marketplace "<name>". Known: <sorted names or '(none)'>`. */
export function unknownMarketplace(name: string, knownNames: readonly string[]): PluginManagerError {
  const known = knownNames.length === 0 ? '(none)' : [...knownNames].sort().join(', ')
  return new PluginManagerError('UNKNOWN_MARKETPLACE', `Unknown marketplace "${name}". Known: ${known}`)
}

/** `Marketplace "<name>" is already registered from a different source (<existing-kind>).` */
export function marketplaceConflict(name: string, existingKind: string): PluginManagerError {
  return new PluginManagerError(
    'MARKETPLACE_CONFLICT',
    `Marketplace "${name}" is already registered from a different source (${existingKind}).`,
  )
}

/** `Marketplace source "<src>" is not a readable directory, owner/repo, or git URL.` */
export function invalidMarketplaceSource(source: string): PluginManagerError {
  return new PluginManagerError(
    'MARKETPLACE_BAD_SOURCE',
    `Marketplace source "${source}" is not a readable directory, owner/repo, or git URL.`,
  )
}

/** `Marketplace at <dir> has no readable .claude-plugin/marketplace.json (<detail>).` */
export function marketplaceManifestMissing(dir: string, detail: string): PluginManagerError {
  return new PluginManagerError(
    'MARKETPLACE_MANIFEST_MISSING',
    `Marketplace at ${dir} has no readable .claude-plugin/marketplace.json (${detail}).`,
  )
}

/** `Marketplace "<mkt>" does not declare a plugin named "<p>".` (S4 declared resolution) */
export function marketplacePluginNotDeclared(marketplace: string, pluginName: string): PluginManagerError {
  return new PluginManagerError(
    'MARKETPLACE_PLUGIN_NOT_DECLARED',
    `Marketplace "${marketplace}" does not declare a plugin named "${pluginName}".`,
  )
}

/** `Unknown plugin "<name>". Declared: <id1>, <id2>` (or `…(none)` when empty). */
export function unknownDeclaredPlugin(name: string, declaredIds: readonly string[]): PluginManagerError {
  const declared = declaredIds.length === 0 ? '(none)' : [...declaredIds].sort().join(', ')
  return new PluginManagerError('UNKNOWN_PLUGIN', `Unknown plugin "${name}". Declared: ${declared}`)
}

/** `Plugin "<id>" uses an unsupported source form (v1 supports directory strings).` */
export function unsupportedPluginSource(id: string): PluginManagerError {
  return new PluginManagerError(
    'PLUGIN_SOURCE_UNSUPPORTED',
    `Plugin "${id}" uses an unsupported source form (v1 supports directory strings).`,
  )
}

/** `Plugin "<id>" is already installed at scope <s> on this machine.` */
export function pluginAlreadyInstalled(id: string, scope: string): PluginManagerError {
  return new PluginManagerError('PLUGIN_ALREADY_INSTALLED', `Plugin "${id}" is already installed at scope ${scope} on this machine.`)
}

/** `Plugin "<id>" has no installation at scope <s> (installed at: <s1>, <s2>).` — scopes in canonical order, or `none`. */
export function noInstallationAtScope(id: string, scope: string, installedScopes: readonly string[]): PluginManagerError {
  const canonical = (['user', 'project', 'local'] as const).filter(s => installedScopes.includes(s))
  const at = canonical.length === 0 ? 'none' : canonical.join(', ')
  return new PluginManagerError('PLUGIN_NOT_INSTALLED', `Plugin "${id}" has no installation at scope ${scope} (installed at: ${at}).`)
}

/** The C5 guard, verbatim: refuse while project settings (team-shared) enable the plugin. */
export function projectScopeEnabledGuard(id: string): PluginManagerError {
  return new PluginManagerError(
    'PLUGIN_ENABLED_AT_PROJECT',
    `Plugin "${id}" is enabled at project scope (.claude/settings.json, shared with your team). To disable just for you: /plugin disable ${id} --scope local`,
  )
}
