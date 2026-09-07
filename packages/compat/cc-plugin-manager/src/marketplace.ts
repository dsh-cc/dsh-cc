/**
 * Marketplace read/write operations (plan §2.2 C1/C6/C8): list, add
 * (directory / `owner/repo` shorthand / git URL), update, remove — all in
 * the byte shapes the real CLI v2.1.236 writes. Clones go through the
 * injectable `GitRunner` into a tmp dir inside `marketplaces/` and are
 * renamed into place only after the cloned manifest names the marketplace
 * (no half-clones); failures remove the tmp dir.
 *
 * @module @dsh-cc/plugin-manager/marketplace
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { gitFailure, createSystemGitRunner, type GitRunner } from './git.ts'
import {
  invalidMarketplaceSource,
  marketplaceConflict,
  marketplaceManifestMissing,
  unknownMarketplace,
  unknownScope,
} from './errors.ts'
import { canonicalizeExistingPath, pluginsStatePaths, settingsFileForScope, type PathInputs } from './paths.ts'
import { parsePluginId } from './resolve-id.ts'
import { loadInstalledPlugins, loadKnownMarketplaces, loadSettingsFile, saveJsonFileAtomic } from './state-store.ts'
import { uninstallPlugin, type InstallDeps } from './uninstall.ts'
import { projectScopeEnabledGuard } from './errors.ts'
import type { MarketplaceSource, MarketplaceSourceKind, Scope, ScopeSettingsFile } from './types.ts'

export interface MarketplaceDeps extends PathInputs {
  /** Injectable clock for `lastUpdated` timestamps. */
  now?: () => Date
  /** Injectable git runner (fakes in tests, host-provided in production). */
  runGit?: GitRunner
}

export interface MarketplaceEntry {
  name: string
  source: MarketplaceSource
  installLocation: string
  lastUpdated: string
  autoUpdate?: boolean
}

export interface AddedMarketplace {
  name: string
  sourceKind: MarketplaceSourceKind
  pluginCount: number
}

export interface RemovedMarketplace {
  name: string
  removedPlugins: string[]
}

export interface AddMarketplaceOptions {
  /** Scope of the settings declaration (default `user`). */
  scope?: string
  now?: () => Date
  runGit?: GitRunner
}

const SCOPES: readonly Scope[] = ['user', 'project', 'local']

function resolveDeps(deps: MarketplaceDeps, opts?: { now?: () => Date; runGit?: GitRunner }): Required<Pick<MarketplaceDeps, 'now' | 'runGit'>> {
  return {
    now: opts?.now ?? deps.now ?? (() => new Date()),
    runGit: opts?.runGit ?? deps.runGit ?? createSystemGitRunner(),
  }
}

function validateScope(scope: string | undefined): Scope {
  if (scope === undefined) return 'user'
  if (!SCOPES.includes(scope as Scope)) throw unknownScope(scope)
  return scope as Scope
}

/** The `source` union a raw CLI string classifies into, or null when unrecognized. */
export type ClassifiedSource = Extract<MarketplaceSource, { source: 'directory' | 'github' | 'git' }>

/**
 * Classify a source string: an existing directory (canonicalized) wins;
 * then git URLs (`https://…`, `git@…`, trailing `.git`); then the
 * `owner/repo` github shorthand; anything else is invalid.
 */
export function classifySource(source: string): ClassifiedSource | null {
  if (existsSync(source) && statSync(source).isDirectory()) {
    return { source: 'directory', path: canonicalizeExistingPath(source) }
  }
  if (/^https:\/\//.test(source) || /^git@/.test(source) || source.endsWith('.git')) {
    return { source: 'git', url: source }
  }
  if (/^[^/\s]+\/[^/\s]+$/.test(source)) {
    return { source: 'github', repo: source }
  }
  return null
}

function kindOf(source: MarketplaceSource): MarketplaceSourceKind {
  return source.source
}

/** Identity comparison for the already-registered check (same kind + same location). */
function sourcesEqual(a: MarketplaceSource, b: MarketplaceSource): boolean {
  if (a.source !== b.source) return false
  if (a.source === 'directory' && b.source === 'directory') return a.path === b.path
  if (a.source === 'github' && b.source === 'github') return a.repo === b.repo
  if (a.source === 'git' && b.source === 'git') return a.url === b.url
  return false
}

/**
 * Read `.claude-plugin/marketplace.json` in a marketplace dir: returns its
 * `name` and plugin count, or throws the exact manifest error (missing /
 * unreadable file → errno detail; missing `name` → `missing "name"`).
 */
async function readManifest(dir: string): Promise<{ name: string, pluginCount: number }> {
  let raw: string
  try {
    raw = await readFile(join(dir, '.claude-plugin', 'marketplace.json'), 'utf8')
  } catch (error) {
    throw marketplaceManifestMissing(dir, (error as NodeJS.ErrnoException).code ?? (error as Error).message)
  }
  let manifest: { name?: unknown, plugins?: unknown }
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    throw marketplaceManifestMissing(dir, (error as Error).message)
  }
  if (typeof manifest['name'] !== 'string' || manifest['name'].length === 0) {
    throw marketplaceManifestMissing(dir, 'missing "name"')
  }
  const plugins = Array.isArray(manifest['plugins']) ? manifest['plugins'] : []
  return { name: manifest['name'], pluginCount: plugins.length }
}

/** C1 `list` rows: known_marketplaces.json entries plus their name. */
export async function listMarketplaces(deps: PathInputs): Promise<MarketplaceEntry[]> {
  const paths = pluginsStatePaths(deps)
  const known = await loadKnownMarketplaces(paths.knownMarketplacesFile)
  return Object.entries(known).map(([name, entry]) => ({
    name,
    source: entry.source,
    installLocation: entry.installLocation,
    lastUpdated: entry.lastUpdated,
    ...(entry.autoUpdate !== undefined ? { autoUpdate: entry.autoUpdate } : {}),
  }))
}

/**
 * Write the known_marketplaces.json entry AND the scope settings
 * declaration (preserving unrelated settings keys, C11), guarding against
 * name conflicts with a different source. Same source ⇒ idempotent.
 */
async function commitAdd(
  deps: PathInputs,
  scope: Scope,
  now: () => Date,
  info: { name: string, source: ClassifiedSource, installLocation: string, sourceKind: MarketplaceSourceKind, pluginCount: number },
): Promise<AddedMarketplace> {
  const paths = pluginsStatePaths(deps)
  const known = await loadKnownMarketplaces(paths.knownMarketplacesFile)
  const existing = known[info.name]
  if (existing !== undefined && !sourcesEqual(existing.source, info.source)) {
    throw marketplaceConflict(info.name, kindOf(existing.source))
  }
  if (existing === undefined) {
    known[info.name] = {
      source: info.source,
      installLocation: info.installLocation,
      lastUpdated: now().toISOString(),
    }
    await saveJsonFileAtomic(paths.knownMarketplacesFile, known)
  }
  const settingsFile = settingsFileForScope(scope, deps)
  const settings: ScopeSettingsFile = await loadSettingsFile(settingsFile)
  const next: ScopeSettingsFile = { ...settings }
  next['extraKnownMarketplaces'] = { ...settings['extraKnownMarketplaces'], [info.name]: { source: info.source } }
  await saveJsonFileAtomic(settingsFile, next)
  return { name: info.name, sourceKind: info.sourceKind, pluginCount: info.pluginCount }
}

/**
 * `marketplace add <source>` (C1): directory sources are validated in place
 * and never copied; github shorthand expands to
 * `https://github.com/<owner>/<repo>.git` and git URLs are cloned as-is via
 * the injected runner into a tmp dir, the marketplace name is read from the
 * cloned manifest, then the clone is renamed into `marketplaces/<name>`.
 */
export async function addMarketplace(deps: MarketplaceDeps, source: string, opts: AddMarketplaceOptions = {}): Promise<AddedMarketplace> {
  const { now, runGit } = resolveDeps(deps, opts)
  const scope = validateScope(opts.scope)
  const paths = pluginsStatePaths(deps)
  const classified = classifySource(source)
  if (classified === null) throw invalidMarketplaceSource(source)

  // Idempotent re-add of the exact same source: succeed without cloning.
  const known = await loadKnownMarketplaces(paths.knownMarketplacesFile)
  for (const [name, entry] of Object.entries(known)) {
    if (sourcesEqual(entry.source, classified)) {
      return {
        name,
        sourceKind: kindOf(entry.source),
        pluginCount: manifestPluginCount(entry.installLocation),
      }
    }
  }

  if (classified.source === 'directory') {
    const manifest = await readManifest(classified.path)
    return commitAdd(deps, scope, now, {
      name: manifest.name,
      source: classified,
      installLocation: classified.path,
      sourceKind: 'directory',
      pluginCount: manifest.pluginCount,
    })
  }

  const url = classified.source === 'github' ? `https://github.com/${classified.repo}.git` : classified.url
  const candidate = (classified.source === 'github' ? basename(classified.repo) : basename(url).replace(/\.git$/, ''))
    .replace(/[^\w.-]/g, '-') || 'marketplace'
  await mkdir(paths.marketplacesDir, { recursive: true })
  const tmpDir = join(paths.marketplacesDir, `.tmp-clone-${candidate}-${process.pid}`)
  let clonedTo: string | null = null
  try {
    const result = await runGit(['clone', url, tmpDir], { cwd: paths.marketplacesDir })
    if (result.code !== 0) throw gitFailure('clone', url, result)
    const manifest = await readManifest(tmpDir)
    const dest = join(paths.marketplacesDir, manifest.name)
    await rename(tmpDir, dest)
    clonedTo = dest
    return await commitAdd(deps, scope, now, {
      name: manifest.name,
      source: classified,
      installLocation: dest,
      sourceKind: classified.source,
      pluginCount: manifest.pluginCount,
    })
  } catch (error) {
    // No residue on any failure (clone failure, bad manifest, conflict):
    // drop the tmp dir, and the renamed clone too if we got that far.
    await rm(tmpDir, { recursive: true, force: true })
    if (clonedTo !== null) await rm(clonedTo, { recursive: true, force: true })
    throw error
  }
}

/** Plugin count for an already-known marketplace: read its manifest in place. */
function manifestPluginCount(dir: string): number {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'marketplace.json'), 'utf8')) as { plugins?: unknown }
    return Array.isArray(manifest['plugins']) ? manifest['plugins'].length : 0
  } catch {
    return 0
  }
}

/**
 * `marketplace update [name]` (C8): all marketplaces when name omitted.
 * Directory sources just re-validate the manifest; git/github sources run
 * `git -C <installLocation> pull --ff-only`. lastUpdated is bumped on
 * success only, then the whole known file is saved.
 */
export async function updateMarketplaces(deps: MarketplaceDeps & { runGit?: GitRunner }, name?: string): Promise<string[]> {
  const { now, runGit } = resolveDeps(deps)
  const paths = pluginsStatePaths(deps)
  const known = await loadKnownMarketplaces(paths.knownMarketplacesFile)
  const names = Object.keys(known)
  if (name !== undefined && !names.includes(name)) throw unknownMarketplace(name, names)
  const targets = name !== undefined ? [name] : [...names].sort()

  const updated: string[] = []
  for (const target of targets) {
    const entry = known[target]!
    if (entry.source.source === 'directory') {
      await readManifest(entry.installLocation)
    } else {
      const result = await runGit(['-C', entry.installLocation, 'pull', '--ff-only'], { cwd: entry.installLocation })
      if (result.code !== 0) throw gitFailure('pull', entry.installLocation, result)
    }
    entry.lastUpdated = now().toISOString()
    updated.push(target)
  }
  if (updated.length > 0) await saveJsonFileAtomic(paths.knownMarketplacesFile, known)
  return updated
}

/**
 * `marketplace remove <name>` (C6). Order per plan §4.C, minus the S4
 * plugin-uninstall steps: (a) TODO(S4) cascade-uninstall hook, (b) remove
 * the clone dir for git-backed sources (only when inside marketplacesDir —
 * directory sources are never deleted), (c) strip
 * `extraKnownMarketplaces[name]` from all three scope settings files,
 * (d) remove the known_marketplaces key (commit).
 */
export async function removeMarketplace(deps: PathInputs, name: string): Promise<RemovedMarketplace> {
  const paths = pluginsStatePaths(deps)
  const known = await loadKnownMarketplaces(paths.knownMarketplacesFile)
  const entry = known[name]
  if (entry === undefined) throw unknownMarketplace(name, Object.keys(known))

  // C6 cascade: uninstall every plugin installed from this marketplace,
  // with the C5 project-scope pre-flight refusing the whole remove before
  // any mutation. Individual uninstall steps skip their own C5 guard since
  // the pre-flight passed.
  const installed = await loadInstalledPlugins(paths.installedPluginsFile)
  const projectSettings = await loadSettingsFile(settingsFileForScope('project', deps))
  const ids = Object.keys(installed.plugins).filter(key => parsePluginId(key).marketplace === name).sort()
  for (const id of ids) {
    if (projectSettings['enabledPlugins']?.[id] === true) throw projectScopeEnabledGuard(id)
  }
  const removedPlugins: string[] = []
  for (const id of ids) {
    const scopes = [...new Set((installed.plugins[id] ?? []).map(installEntry => installEntry.scope))]
    for (const scope of scopes) {
      await uninstallPlugin(deps as InstallDeps, id, { scope, skipProjectGuard: true })
    }
    removedPlugins.push(id)
  }

  if (entry.source.source !== 'directory') {
    const loc = resolve(entry.installLocation)
    const inside = canonicalizeExistingPath(paths.marketplacesDir)
    if (existsSync(loc) && canonicalizeExistingPath(dirname(loc)) === inside) {
      await rm(loc, { recursive: true, force: true })
    }
  }

  for (const scope of SCOPES) {
    const settingsFile = settingsFileForScope(scope, deps)
    const settings = await loadSettingsFile(settingsFile)
    if (settings['extraKnownMarketplaces']?.[name] === undefined) continue
    const next: ScopeSettingsFile = { ...settings }
    next['extraKnownMarketplaces'] = { ...settings['extraKnownMarketplaces'] }
    delete next['extraKnownMarketplaces']![name]
    await saveJsonFileAtomic(settingsFile, next)
  }

  delete known[name]
  await saveJsonFileAtomic(paths.knownMarketplacesFile, known)
  return { name, removedPlugins }
}
