/**
 * uninstall (plan §2.2 C4/C5): scope-surgical removal of one scope's
 * enabledPlugins flag and installed entry, then `.orphaned_at` marking of a
 * cache dir left unreferenced (never deleted). The C5 guard refuses while
 * the project settings file (team-shared) still enables the plugin.
 *
 * @module @dsh-cc/plugin-manager/uninstall
 */

import { noInstallationAtScope, projectScopeEnabledGuard } from './errors.ts'
import { orphanIfUnreferenced, resolveMutationScope, type InstallDeps } from './install.ts'

export type { InstallDeps } from './install.ts'
import { pluginsStatePaths, settingsFileForScope } from './paths.ts'
import { resolveInstalledPluginId } from './resolve-id.ts'
import { applyEnabledFlag } from './settings-write.ts'
import { loadInstalledPlugins, loadSettingsFile, saveJsonFileAtomic } from './state-store.ts'
import type { Scope } from './types.ts'

export interface UninstallOptions {
  scope?: string
  /**
   * Internal: the marketplace-remove cascade has already run the C5
   * pre-flight over every plugin, so per-entry guards are skipped.
   */
  skipProjectGuard?: boolean
}

export interface UninstallResult {
  id: string
  scope: Scope
}

/**
 * `uninstall <idOrName> [--scope s]` (C4). Order per §4.C: C5 guard →
 * remove the scope's enabledPlugins key → remove the scope's installed
 * entry (commit) → `.orphaned_at` on cache dirs left unreferenced.
 */
export async function uninstallPlugin(deps: InstallDeps, arg: string, opts: UninstallOptions = {}): Promise<UninstallResult> {
  const now = deps.now ?? (() => new Date())
  const scope = resolveMutationScope(opts.scope)
  const paths = pluginsStatePaths(deps)
  const installed = await loadInstalledPlugins(paths.installedPluginsFile)
  const id = resolveInstalledPluginId(arg, Object.keys(installed.plugins))
  const entries = installed.plugins[id] ?? []
  const entry = entries.find(candidate => candidate.scope === scope)
  if (entry === undefined) {
    throw noInstallationAtScope(id, scope, entries.map(candidate => candidate.scope))
  }

  // C5 guard: the project settings file is shared with the team.
  if (opts.skipProjectGuard !== true) {
    const projectSettings = await loadSettingsFile(settingsFileForScope('project', deps))
    if (projectSettings['enabledPlugins']?.[id] === true) throw projectScopeEnabledGuard(id)
  }

  // (1) remove the enabledPlugins key at the targeted scope's file only.
  await applyEnabledFlag(deps, scope, id, null)
  // (2) remove that scope's array entry (drop the id key when it empties).
  const remaining = entries.filter(candidate => candidate !== entry)
  if (remaining.length === 0) delete installed.plugins[id]
  else installed.plugins[id] = remaining
  await saveJsonFileAtomic(paths.installedPluginsFile, installed)
  // (3) orphan-marker the cache dir when nothing references it anymore.
  await orphanIfUnreferenced(installed, entry.installPath, now)
  return { id, scope }
}
