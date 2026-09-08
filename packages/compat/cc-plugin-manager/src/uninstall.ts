/**
 * uninstall (plan §2.2 C4/C5): scope-surgical removal of one scope's
 * enabledPlugins flag and installed entry, then `.orphaned_at` marking of a
 * cache dir left unreferenced (never deleted). The C5 guard refuses while
 * the project settings file (team-shared) still enables the plugin.
 *
 * @module @dsh-cc/plugin-manager/uninstall
 */

import { join } from 'node:path'
import { noInstallationAtScope, projectScopeEnabledGuard } from './errors.ts'
import { orphanIfUnreferencedDsh, resolveMutationScope, type InstallDeps } from './install.ts'

export type { InstallDeps } from './install.ts'
import { claudePluginsStatePaths, pluginsStatePaths, settingsFileForScope } from './paths.ts'
import { loadMergedInstalledPlugins } from './merged-state.ts'
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
  const claudePaths = claudePluginsStatePaths(deps)
  // Merged installed view (§3.4). Uninstall resolves over ALL merged ids
  // (not the resolution view): an id shadowed by an empty dsh list still
  // reports `installed at: none` rather than unknown-plugin (C4 pin).
  const merged = await loadMergedInstalledPlugins(deps)
  const id = resolveInstalledPluginId(arg, Object.keys(merged.file.plugins))
  const entries = merged.file.plugins[id] ?? []
  const entry = entries.find(candidate => candidate.scope === scope)
  if (entry === undefined) {
    throw noInstallationAtScope(id, scope, entries.map(candidate => candidate.scope))
  }

  // C5 guard: the project settings file is shared with the team.
  if (opts.skipProjectGuard !== true) {
    const projectSettings = await loadSettingsFile(settingsFileForScope('project', deps))
    if (projectSettings['enabledPlugins']?.[id] === true) throw projectScopeEnabledGuard(id)
  }

  // (1) remove the enabledPlugins key at the targeted scope's file only —
  // with the §4.3 conditional user-flag shadow: dual-home AND the claude
  // user file carries `true` ⇒ write an explicit `false` into the dsh user
  // file instead (removal would un-shadow and resurrect the claude `true`).
  if (scope === 'user' && claudePaths !== null) {
    const claudeSettings = await loadSettingsFile(join(deps.claudeHome, 'settings.json'))
    if (claudeSettings['enabledPlugins']?.[id] === true) await applyEnabledFlag(deps, scope, id, false)
    else await applyEnabledFlag(deps, scope, id, null)
  } else {
    await applyEnabledFlag(deps, scope, id, null)
  }
  // (2) remove that scope's array entry, then materialize the id's full
  // post-removal MERGED list into the dsh file (§3.4; `[]` allowed — it
  // shadows the claude id). Single-root keeps C4 byte-parity: the key drops.
  const remaining = entries.filter(candidate => candidate !== entry)
  const dshInstalled = await loadInstalledPlugins(paths.installedPluginsFile)
  if (claudePaths === null) {
    if (remaining.length === 0) delete dshInstalled.plugins[id]
    else dshInstalled.plugins[id] = remaining
  } else {
    dshInstalled.plugins[id] = remaining
  }
  await saveJsonFileAtomic(paths.installedPluginsFile, dshInstalled)
  // (3) orphan-marker under the dsh cache only, when nothing in the merged
  // view references the path anymore (W3/W4).
  merged.file.plugins[id] = remaining
  await orphanIfUnreferencedDsh(deps, merged.file, entry.installPath, now)
  return { id, scope }
}
