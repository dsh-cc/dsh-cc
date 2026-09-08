/**
 * Merged dual-home state readers (plan §3.2–§3.5): layered per-key maps in
 * which the dsh home (write root) is authoritative over the claude home
 * (compat read root) for keys it carries, while claude-only keys pass
 * through. Nothing is cached — every call re-reads both homes. The dsh
 * `known_marketplaces.json` may carry `null` tombstones (dsh-private
 * extension, §3.5); the claude file keeps the strict CC type. In single-root
 * mode (both homes canonicalize equal) each file is read exactly once.
 *
 * @module @dsh-cc/plugin-manager/merged-state
 */

import { claudePluginsStatePaths, pluginsStatePaths, userSettingsReadFiles, type PathInputs } from './paths.ts'
import { loadInstalledPlugins, loadJsonFile, loadSettingsFile } from './state-store.ts'
import type { EnabledPlugins, InstallEntry, InstalledPluginsFile, KnownMarketplaceEntry, KnownMarketplacesFile } from './types.ts'

/** Which home a merged key came from (provenance for later slices, §3.2). */
export type MergeOrigin = 'dsh' | 'claude'

/** The dsh known-marketplaces file may carry `null` tombstones (§3.5). */
export type DshKnownMarketplacesFile = Record<string, KnownMarketplaceEntry | null>

export interface MergedKnownMarketplaces {
  /** Merged entries; dsh-tombstoned names are omitted. */
  entries: KnownMarketplacesFile
  /** Per-name origin, tracking the authoritative home. */
  origin: Record<string, MergeOrigin>
}

export interface MergedInstalledPlugins {
  /** Merged file: per id, the dsh entry list — including an empty one — shadows the claude list (§3.4). */
  file: InstalledPluginsFile
  /** Per-id origin, tracking the authoritative home. */
  origin: Record<string, MergeOrigin>
}

/**
 * Merged `known_marketplaces.json` (§3.5): per name a dsh entry wins;
 * claude-only names pass through; a dsh `null` tombstones the name out of
 * the merged view (and its origin).
 */
export async function loadMergedKnownMarketplaces(deps: PathInputs): Promise<MergedKnownMarketplaces> {
  const paths = pluginsStatePaths(deps)
  const claudePaths = claudePluginsStatePaths(deps)
  const entries: KnownMarketplacesFile = {}
  const origin: Record<string, MergeOrigin> = {}
  if (claudePaths !== null) {
    const claude = await loadJsonFile<KnownMarketplacesFile>(claudePaths.knownMarketplacesFile, {})
    for (const [name, entry] of Object.entries(claude)) {
      entries[name] = entry
      origin[name] = 'claude'
    }
  }
  const dsh = await loadJsonFile<DshKnownMarketplacesFile>(paths.knownMarketplacesFile, {})
  for (const [name, entry] of Object.entries(dsh)) {
    if (entry === null) {
      delete entries[name]
      delete origin[name]
      continue
    }
    entries[name] = entry
    origin[name] = 'dsh'
  }
  return { entries, origin }
}

/**
 * Merged `installed_plugins.json` (§3.4): per plugin id the dsh entry list —
 * including the empty list — shadows the claude list; claude-only ids pass
 * through. Entries' `installPath`s freely mix homes.
 */
export async function loadMergedInstalledPlugins(deps: PathInputs): Promise<MergedInstalledPlugins> {
  const paths = pluginsStatePaths(deps)
  const claudePaths = claudePluginsStatePaths(deps)
  const file: InstalledPluginsFile = { version: 2, plugins: {} }
  const origin: Record<string, MergeOrigin> = {}
  if (claudePaths !== null) {
    const claude = await loadInstalledPlugins(claudePaths.installedPluginsFile)
    for (const [id, entries] of Object.entries(claude.plugins)) {
      file.plugins[id] = entries
      origin[id] = 'claude'
    }
  }
  const dsh = await loadInstalledPlugins(paths.installedPluginsFile)
  for (const [id, entries] of Object.entries(dsh.plugins)) {
    file.plugins[id] = entries as InstallEntry[]
    origin[id] = 'dsh'
  }
  return { file, origin }
}

/**
 * The resolution view of a merged installed file (§3.4): ids whose merged
 * entry list is non-empty. A shadowed (empty-list) id never resolves as
 * installed.
 */
export function resolutionIds(file: InstalledPluginsFile): string[] {
  return Object.keys(file.plugins).filter(id => file.plugins[id]!.length > 0)
}

/**
 * Merged user-scope `enabledPlugins` (§3.3): the dsh user settings value
 * wins per key over the claude user settings; keys absent from the dsh file
 * re-expose the claude value ("un-override").
 */
export async function loadMergedUserEnabledPlugins(deps: PathInputs): Promise<EnabledPlugins> {
  const merged: EnabledPlugins = {}
  for (const file of userSettingsReadFiles(deps)) {
    const settings = await loadSettingsFile(file)
    Object.assign(merged, settings['enabledPlugins'] ?? {})
  }
  return merged
}
