/**
 * install (plan §2.2 C2 + §4.C commit order): copy the declared plugin
 * source dir into `<cacheDir>/<mkt>/<name>/<version>/`, then write the
 * scope's `enabledPlugins[id] = true` flag, then commit the
 * `installed_plugins.json` entry. A failure at any step leaves the state
 * files untouched-or-consistent (an unreferenced cache dir or an
 * enabled-but-not-installed flag is benign residue discovery ignores).
 *
 * @module @dsh-cc/plugin-manager/install
 */

import { cp, readFile, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { GitRunner } from './git.ts'
import { pluginAlreadyInstalled, unknownMarketplace, unknownScope } from './errors.ts'
import { canonicalizeExistingPath, pluginsStatePaths, type PathInputs } from './paths.ts'
import { loadMergedInstalledPlugins, loadMergedKnownMarketplaces } from './merged-state.ts'
import { parsePluginId, readDeclaredPlugins, resolveDeclaredPluginId } from './resolve-id.ts'
import { applyEnabledFlag } from './settings-write.ts'
import { loadInstalledPlugins, saveJsonFileAtomic } from './state-store.ts'
import type { InstallEntry, InstalledPluginsFile, Scope } from './types.ts'

export interface InstallDeps extends PathInputs {
  /** Injectable clock for installedAt/lastUpdated timestamps. */
  now?: () => Date
  /** Injectable git runner for the rev-parse HEAD probe. */
  runGit?: GitRunner
}

export interface InstallOptions {
  scope?: string
}

export interface InstallResult {
  id: string
  version: string
  scope: Scope
  installPath: string
}

const SCOPES: readonly Scope[] = ['user', 'project', 'local']

/** Validate an explicit scope override (default `user`). */
export function resolveMutationScope(scope: string | undefined): Scope {
  if (scope === undefined) return 'user'
  if (!SCOPES.includes(scope as Scope)) throw unknownScope(scope)
  return scope as Scope
}

/** `<cacheDir>/<marketplace>/<plugin>/<version>` layout (C2). */
export function cacheDirFor(cacheDir: string, marketplace: string, plugin: string, version: string): string {
  return join(cacheDir, marketplace, plugin, version)
}

/**
 * Read a plugin manifest at `<dir>/.claude-plugin/plugin.json` (nested
 * preferred, loader convention) falling back to top-level `<dir>/plugin.json`.
 * A missing/unreadable manifest is tolerated as `{ name, version: 'unknown' }`
 * — the loader tolerates auto-discovery of manifest-less plugin dirs.
 */
export async function readPluginManifest(dir: string, fallbackName: string): Promise<{ name: string, version: string }> {
  for (const rel of ['.claude-plugin/plugin.json', 'plugin.json']) {
    try {
      const manifest = JSON.parse(await readFile(join(dir, rel), 'utf8')) as Record<string, unknown>
      const name = typeof manifest['name'] === 'string' ? manifest['name'] : fallbackName
      const version = typeof manifest['version'] === 'string' ? manifest['version'] : 'unknown'
      return { name, version }
    } catch {
      // try the next convention; a missing manifest is tolerated
    }
  }
  return { name: fallbackName, version: 'unknown' }
}

/**
 * Probe `git -C <installLocation> rev-parse HEAD` when a runner is
 * available; the sha is captured on success and silently omitted when git
 * fails or the runner is absent (directory sources typically have no git
 * history — probe C2).
 */
export async function currentGitSha(runGit: GitRunner | undefined, installLocation: string): Promise<string | undefined> {
  if (runGit === undefined) return undefined
  try {
    const result = await runGit(['-C', installLocation, 'rev-parse', 'HEAD'], { cwd: installLocation })
    const sha = result.stdout.trim()
    if (result.code === 0 && /^[0-9a-f]{7,40}$/i.test(sha)) return sha
  } catch {
    // no git history → omit
  }
  return undefined
}

/** Write the `.orphaned_at` epoch-millis marker (ASCII, no newline) into a cache dir. Never deletes. */
export async function writeOrphanMarker(dir: string, now: () => Date): Promise<void> {
  try {
    await writeFile(join(dir, '.orphaned_at'), String(now().getTime()), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Mark `installPath` orphaned iff no remaining installed entry references it. */
export async function orphanIfUnreferenced(installed: InstalledPluginsFile, installPath: string, now: () => Date): Promise<void> {
  for (const entries of Object.values(installed.plugins)) {
    for (const entry of entries) {
      if (entry.installPath === installPath) return
    }
  }
  await writeOrphanMarker(installPath, now)
}

/**
 * W4-gated orphan marking: only install paths under the DSH cache dir
 * (realpath-prefix check) may be marked, and only when no remaining MERGED
 * entry references the path. Claude-owned cache dirs are never touched (W3).
 */
export async function orphanIfUnreferencedDsh(deps: PathInputs, installed: InstalledPluginsFile, installPath: string, now: () => Date): Promise<void> {
  const dshCacheDir = canonicalizeExistingPath(pluginsStatePaths(deps).cacheDir)
  let canonical: string
  try {
    canonical = canonicalizeExistingPath(installPath)
  } catch {
    return
  }
  if (canonical !== dshCacheDir && !canonical.startsWith(dshCacheDir + sep)) return
  await orphanIfUnreferenced(installed, installPath, now)
}

/** Commit step 1: recursively copy the source dir into the cache layout. */
export async function materializeCacheDir(cacheDir: string, marketplace: string, plugin: string, version: string, sourceDir: string): Promise<string> {
  const dest = cacheDirFor(cacheDir, marketplace, plugin, version)
  await cp(sourceDir, dest, { recursive: true })
  return dest
}

/**
 * `install <idOrName> [--scope s]` (C2). Resolves the argument against the
 * plugins each known marketplace declares, then runs the §4.C commit order.
 */
export async function installPlugin(deps: InstallDeps, arg: string, opts: InstallOptions = {}): Promise<InstallResult> {
  const now = deps.now ?? (() => new Date())
  const scope = resolveMutationScope(opts.scope)
  const paths = pluginsStatePaths(deps)
  const known = (await loadMergedKnownMarketplaces(deps)).entries
  const names = Object.keys(known)

  // Build the declared-id map; unreadable marketplace manifests are recorded
  // and surfaced when resolution actually needs that marketplace.
  const declaredIds = new Map<string, readonly string[]>()
  const manifestErrors = new Map<string, unknown>()
  for (const name of names) {
    try {
      const declared = await readDeclaredPlugins(deps, name)
      declaredIds.set(name, declared.map(plugin => `${plugin.name}@${name}`))
    } catch (error) {
      declaredIds.set(name, [])
      manifestErrors.set(name, error)
    }
  }
  const parsed = parsePluginId(arg)
  if (parsed.marketplace !== undefined) {
    if (!names.includes(parsed.marketplace)) throw unknownMarketplace(parsed.marketplace, names)
    const manifestError = manifestErrors.get(parsed.marketplace)
    if (manifestError !== undefined) throw manifestError
  }
  let id: string
  try {
    id = resolveDeclaredPluginId(arg, declaredIds)
  } catch (error) {
    if (parsed.marketplace === undefined && manifestErrors.size > 0) {
      // Bare-name resolution failed against the healthy marketplaces — the
      // recorded manifest error may be the real reason, so surface it.
      for (const manifestError of manifestErrors.values()) throw manifestError
    }
    throw error
  }

  const resolved = parsePluginId(id)
  const marketplace = resolved.marketplace!
  const mktEntry = known[marketplace]!
  const declared = await readDeclaredPlugins(deps, marketplace)
  const declaredPlugin = declared.find(plugin => plugin.name === resolved.name)!
  const sourceDir = join(mktEntry.installLocation, declaredPlugin.source)
  const manifest = await readPluginManifest(sourceDir, declaredPlugin.name)
  const version = manifest.version

  // Merged installed view (§3.4): pluginAlreadyInstalled checks the merged
  // list per scope, regardless of which home holds the prior entry.
  const merged = await loadMergedInstalledPlugins(deps)
  if ((merged.file.plugins[id] ?? []).some(entry => entry.scope === scope)) throw pluginAlreadyInstalled(id, scope)

  // §4.C (1) cache copy — fails before any state mutation (dsh cache).
  const installPath = await materializeCacheDir(paths.cacheDir, marketplace, declaredPlugin.name, version, sourceDir)
  // (2) enabledPlugins flag at the scope's settings file (user → dsh, §3.3).
  await applyEnabledFlag(deps, scope, id, true)
  // (3) installed_plugins.json entry (commit): the id's full post-mutation
  // MERGED list is materialized into the dsh file (§3.4 materialization-on-write).
  const sha = await currentGitSha(deps.runGit, mktEntry.installLocation)
  const timestamp = now().toISOString()
  const record: InstallEntry = { scope, installPath, version, installedAt: timestamp, lastUpdated: timestamp }
  if (sha !== undefined) record.gitCommitSha = sha
  if (scope !== 'user') record.projectPath = canonicalizeExistingPath(deps.cwd)
  const dshInstalled = await loadInstalledPlugins(paths.installedPluginsFile)
  dshInstalled.plugins[id] = [...(merged.file.plugins[id] ?? []), record]
  await saveJsonFileAtomic(paths.installedPluginsFile, dshInstalled)
  return { id, version, scope, installPath }
}
