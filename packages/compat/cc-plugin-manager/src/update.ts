/**
 * update (plan §2.2 C7): materialize the new version's cache dir alongside
 * the old one and rewrite only the targeted scope's installed entry; the
 * old cache dir is orphan-marked only when nothing references it anymore.
 *
 * @module @dsh-cc/plugin-manager/update
 */

import { noInstallationAtScope, unknownMarketplace } from './errors.ts'
import { currentGitSha, materializeCacheDir, orphanIfUnreferencedDsh, readPluginManifest, resolveMutationScope, type InstallDeps } from './install.ts'
import { pluginsStatePaths } from './paths.ts'
import { loadMergedInstalledPlugins, loadMergedKnownMarketplaces, resolutionIds } from './merged-state.ts'
import { parsePluginId, readDeclaredPlugins, resolveInstalledPluginId } from './resolve-id.ts'
import { loadInstalledPlugins, saveJsonFileAtomic } from './state-store.ts'
import type { Scope } from './types.ts'

export interface UpdateOptions {
  scope?: string
}

export type UpdateResult =
  | { upToDate: true, id: string, version: string, scope: Scope }
  | { upToDate: false, id: string, fromVersion: string, toVersion: string, scope: Scope }

/**
 * `update <idOrName> [--scope s]` (C7, default scope user). Reads the
 * currently declared manifest from the plugin's marketplace; equal version
 * ⇒ up-to-date no-op. A bump materializes
 * `<cacheDir>/<mkt>/<name>/<newVersion>/` and rewrites ONLY the targeted
 * scope's entry (version, installPath, fresh timestamps, refreshed
 * gitCommitSha when available).
 */
export async function updatePlugin(deps: InstallDeps, arg: string, opts: UpdateOptions = {}): Promise<UpdateResult> {
  const now = deps.now ?? (() => new Date())
  const scope = resolveMutationScope(opts.scope)
  const paths = pluginsStatePaths(deps)
  // Merged installed + known views (§4.4).
  const merged = await loadMergedInstalledPlugins(deps)
  const id = resolveInstalledPluginId(arg, resolutionIds(merged.file))
  const entries = merged.file.plugins[id] ?? []
  const entry = entries.find(candidate => candidate.scope === scope)
  if (entry === undefined) {
    throw noInstallationAtScope(id, scope, entries.map(candidate => candidate.scope))
  }

  const { name, marketplace } = parsePluginId(id)
  const known = (await loadMergedKnownMarketplaces(deps)).entries
  if (marketplace === undefined || known[marketplace] === undefined) {
    throw unknownMarketplace(marketplace ?? '', Object.keys(known))
  }
  const mktEntry = known[marketplace]!
  const declared = await readDeclaredPlugins(deps, marketplace)
  const declaredPlugin = declared.find(plugin => plugin.name === name)
  const sourceDir = declaredPlugin !== undefined ? `${mktEntry.installLocation}/${declaredPlugin.source}` : entry.installPath
  const { version: newVersion } = await readPluginManifest(sourceDir, name)

  if (newVersion === entry.version) {
    return { upToDate: true, id, version: entry.version, scope }
  }

  // Materialize the new cache dir into the DSH cache (even for a
  // claude-owned marketplace clone — the clone is only read, W3), then
  // rewrite the targeted scope's entry in the dsh file (§3.4).
  const installPath = await materializeCacheDir(paths.cacheDir, marketplace, name, newVersion, sourceDir)
  const updated: typeof entry = { ...entry, version: newVersion, installPath, installedAt: now().toISOString(), lastUpdated: now().toISOString() }
  const sha = await currentGitSha(deps.runGit, mktEntry.installLocation)
  if (sha !== undefined) updated.gitCommitSha = sha
  else delete updated.gitCommitSha
  const newEntries = entries.map(candidate => (candidate === entry ? updated : candidate))
  const dshInstalled = await loadInstalledPlugins(paths.installedPluginsFile)
  dshInstalled.plugins[id] = newEntries
  await saveJsonFileAtomic(paths.installedPluginsFile, dshInstalled)
  // W4: an old claude-owned installPath is never orphan-marked; a dsh-owned
  // one is, when nothing in the merged view references it anymore.
  merged.file.plugins[id] = newEntries
  await orphanIfUnreferencedDsh(deps, merged.file, entry.installPath, now)
  return { upToDate: false, id, fromVersion: entry.version, toVersion: newVersion, scope }
}
