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
import { canonicalizeExistingPath, claudePluginsStatePaths, pluginsStatePaths, settingsFileForScope, type PathInputs, type PluginsStatePaths } from './paths.ts'
import { loadMergedInstalledPlugins, loadMergedKnownMarketplaces } from './merged-state.ts'
import { parsePluginId } from './resolve-id.ts'
import { loadJsonFile, loadKnownMarketplaces, loadSettingsFile, saveJsonFileAtomic } from './state-store.ts'
import { uninstallPlugin, type InstallDeps } from './uninstall.ts'
import { marketplaceNameMismatch, projectScopeEnabledGuard } from './errors.ts'
import type { KnownMarketplaceEntry, MarketplaceSource, MarketplaceSourceKind, Scope, ScopeSettingsFile } from './types.ts'

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
  /**
   * Set when the re-add shadowed a claude-home entry with a DIFFERENT
   * source (plan §4.5): the dsh registration management-claims the name and
   * the command layer prints a one-line notice.
   */
  shadowedClaudeEntry?: true
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

/** C1 `list` rows: MERGED known entries (dsh wins per name; tombstoned names absent) plus their name. */
export async function listMarketplaces(deps: PathInputs): Promise<MarketplaceEntry[]> {
  const known = (await loadMergedKnownMarketplaces(deps)).entries
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
 *
 * Dual-home awareness (plan §4.5): the dsh known file may carry a `null`
 * tombstone for the name — a tombstoned name counts as ABSENT for conflict
 * detection (re-add always succeeds and clears the tombstone). When the
 * claude file carries the same name: a same source is reused by REFERENCE
 * (the dsh entry points at the claude entry's installLocation, no clone);
 * a different source clones fresh and the result carries
 * `shadowedClaudeEntry: true`. Returns whether the fresh clone is actually
 * referenced (false ⇒ the caller drops it).
 */
async function commitAdd(
  deps: PathInputs,
  scope: Scope,
  now: () => Date,
  info: { name: string, source: ClassifiedSource, installLocation: string, sourceKind: MarketplaceSourceKind, pluginCount: number },
): Promise<{ result: AddedMarketplace, cloned: boolean }> {
  const paths = pluginsStatePaths(deps)
  const dshKnown = await loadKnownMarketplaces(paths.knownMarketplacesFile)
  const claudePaths = claudePluginsStatePaths(deps)
  const claudeKnown = claudePaths === null
    ? {}
    : await loadJsonFile<Record<string, KnownMarketplaceEntry>>(claudePaths.knownMarketplacesFile, {})
  const dshExisting = dshKnown[info.name]
  const claudeExisting = claudeKnown[info.name]
  // Conflict detection: a live dsh entry with a different source (a null
  // tombstone is absent from the merged view, §4.5).
  if (dshExisting != null && !sourcesEqual(dshExisting.source, info.source)) {
    throw marketplaceConflict(info.name, kindOf(dshExisting.source))
  }
  const claudeEntryPresent = dshExisting == null && claudeExisting !== undefined
  const sameAsClaude = claudeEntryPresent && sourcesEqual(claudeExisting!.source, info.source)
  const shadowed = claudeEntryPresent && !sameAsClaude

  let entry: KnownMarketplaceEntry
  let cloned = true
  if (sameAsClaude) {
    // Reference, no clone (§4.5): promote-on-write handles freshness later.
    entry = { ...claudeExisting!, lastUpdated: now().toISOString() }
    cloned = false
  } else {
    entry = {
      source: info.source,
      installLocation: info.installLocation,
      lastUpdated: now().toISOString(),
    }
  }
  dshKnown[info.name] = entry
  await saveJsonFileAtomic(paths.knownMarketplacesFile, dshKnown)

  const settingsFile = settingsFileForScope(scope, deps)
  const settings: ScopeSettingsFile = await loadSettingsFile(settingsFile)
  const next: ScopeSettingsFile = { ...settings }
  next['extraKnownMarketplaces'] = { ...settings['extraKnownMarketplaces'], [info.name]: { source: info.source } }
  await saveJsonFileAtomic(settingsFile, next)
  return {
    result: {
      name: info.name,
      sourceKind: info.sourceKind,
      pluginCount: info.pluginCount,
      ...(shadowed ? { shadowedClaudeEntry: true as const } : {}),
    },
    cloned,
  }
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

  // Idempotent re-add of the exact same source against the MERGED known map
  // (§4.5): an entry in either home ⇒ idempotent success, no clone. A dsh
  // tombstoned name is absent from the merged view and never matches here.
  const mergedKnown = (await loadMergedKnownMarketplaces(deps)).entries
  for (const [name, entry] of Object.entries(mergedKnown)) {
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
    const committed = await commitAdd(deps, scope, now, {
      name: manifest.name,
      source: classified,
      installLocation: classified.path,
      sourceKind: 'directory',
      pluginCount: manifest.pluginCount,
    })
    return committed.result
  }

  const url = classified.source === 'github' ? `https://github.com/${classified.repo}.git` : classified.url
  const candidate = (classified.source === 'github' ? basename(classified.repo) : basename(url).replace(/\.git$/, ''))
    .replace(/[^\w.-]/g, '-') || 'marketplace'

  // §4.5 reference fast path: a claude entry for the candidate name with the
  // SAME source is reused by reference without cloning (the tombstone case —
  // the merged-view loop above already returned for live entries). The
  // commit-time reference check remains the authority when the manifest name
  // differs from the candidate.
  const claudePaths = claudePluginsStatePaths(deps)
  if (claudePaths !== null) {
    const claudeKnown = await loadJsonFile<Record<string, KnownMarketplaceEntry>>(claudePaths.knownMarketplacesFile, {})
    const claudeEntry = claudeKnown[candidate]
    if (claudeEntry !== undefined && sourcesEqual(claudeEntry.source, classified)) {
      const committed = await commitAdd(deps, scope, now, {
        name: candidate,
        source: classified,
        installLocation: claudeEntry.installLocation,
        sourceKind: kindOf(classified),
        pluginCount: manifestPluginCount(claudeEntry.installLocation),
      })
      return committed.result
    }
  }

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
    const committed = await commitAdd(deps, scope, now, {
      name: manifest.name,
      source: classified,
      installLocation: dest,
      sourceKind: classified.source,
      pluginCount: manifest.pluginCount,
    })
    if (!committed.cloned && clonedTo !== null) {
      // The dsh entry references the claude entry's clone — drop ours (§4.5).
      await rm(clonedTo, { recursive: true, force: true })
      clonedTo = null
    }
    return committed.result
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
 * `marketplace update [name]` (C8): all marketplaces when name omitted, over
 * the MERGED known map (§4.7). Dsh-owned entries: directory sources just
 * re-validate the manifest; git/github sources run
 * `git -C <installLocation> pull --ff-only`. Claude-owned entries are
 * promoted on write (never a pull inside the claude home). The dsh known
 * file is committed after each processed marketplace (decision G).
 */
export async function updateMarketplaces(deps: MarketplaceDeps & { runGit?: GitRunner }, name?: string): Promise<string[]> {
  const { now, runGit } = resolveDeps(deps)
  const paths = pluginsStatePaths(deps)
  const mergedKnown = await loadMergedKnownMarketplaces(deps)
  const names = Object.keys(mergedKnown.entries)
  if (name !== undefined && !names.includes(name)) throw unknownMarketplace(name, names)
  const targets = name !== undefined ? [name] : [...names].sort()

  const updated: string[] = []
  for (const target of targets) {
    const entry = mergedKnown.entries[target]!
    let newEntry: KnownMarketplaceEntry
    if (mergedKnown.origin[target] === 'dsh') {
      // Dsh-owned entry: today's behavior (pull --ff-only / re-validate).
      if (entry.source.source === 'directory') {
        await readManifest(entry.installLocation)
      } else {
        const result = await runGit(['-C', entry.installLocation, 'pull', '--ff-only'], { cwd: entry.installLocation })
        if (result.code !== 0) throw gitFailure('pull', entry.installLocation, result)
      }
      newEntry = { ...entry, lastUpdated: now().toISOString() }
    } else if (entry.source.source === 'directory') {
      // Claude-owned directory source: no clone — the dsh entry points at
      // the same external path with refreshed lastUpdated (§4.7).
      await readManifest(entry.installLocation)
      newEntry = { ...entry, lastUpdated: now().toISOString() }
    } else {
      // Claude-owned git/github entry: promote-on-write (§4.7) — never run
      // `git pull` inside the claude home.
      newEntry = await promoteGitEntry(entry, target, now, runGit, paths)
    }
    // Per-entry commit (decision G, §4.7): the dsh known file is saved after
    // EACH successfully processed marketplace, so a mid-batch failure
    // persists the processed prefix.
    const dshKnown = await loadKnownMarketplaces(paths.knownMarketplacesFile)
    dshKnown[target] = newEntry
    await saveJsonFileAtomic(paths.knownMarketplacesFile, dshKnown)
    updated.push(target)
  }
  return updated
}

/**
 * Promote a claude-owned git/github entry (§4.7): fresh `git clone <source>`
 * into `<dshHome>/plugins/marketplaces/<name>` under the tmp-dir + rename +
 * rollback discipline. The clone's manifest name must match the entry name
 * (`marketplaceNameMismatch` otherwise, clone dropped); the dsh entry keeps
 * all claude entry fields (autoUpdate, unknown extras) with the new
 * installLocation and refreshed lastUpdated. The claude home is untouched.
 */
async function promoteGitEntry(
  entry: KnownMarketplaceEntry,
  name: string,
  now: () => Date,
  runGit: GitRunner,
  paths: PluginsStatePaths,
): Promise<KnownMarketplaceEntry> {
  const source = entry.source
  if (source.source === 'directory') throw marketplaceConflict(name, 'directory')
  const url = source.source === 'github' ? `https://github.com/${source.repo}.git` : source.url
  await mkdir(paths.marketplacesDir, { recursive: true })
  const dest = join(paths.marketplacesDir, name)
  // Residue self-heal (§4.7): a dsh clone dir with no dsh known entry
  // referencing it is a crashed earlier attempt — remove and re-clone.
  if (existsSync(dest)) {
    const dshKnown = await loadKnownMarketplaces(paths.knownMarketplacesFile)
    const referenced = Object.values(dshKnown).some(candidate => candidate !== null && candidate.installLocation === dest)
    if (!referenced) await rm(dest, { recursive: true, force: true })
  }
  const tmpDir = join(paths.marketplacesDir, `.tmp-promote-${name}-${process.pid}`)
  try {
    const result = await runGit(['clone', url, tmpDir], { cwd: paths.marketplacesDir })
    if (result.code !== 0) throw gitFailure('clone', url, result)
    const manifest = await readManifest(tmpDir)
    if (manifest.name !== name) throw marketplaceNameMismatch(name, manifest.name)
    await rename(tmpDir, dest)
    return { ...entry, installLocation: dest, lastUpdated: now().toISOString() }
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true })
    throw error
  }
}

/**
 * `marketplace remove <name>` (C6): C6 pre-flight (C5 project-guard per
 * plugin) over the MERGED installed view, then per-id cascade uninstall per
 * §4.3; claude-owned clone dirs are never deleted (W3 — only dirs inside
 * the DSH marketplaces dir are removed); the known name gets a dsh `null`
 * tombstone (§3.5, dual-home) or a plain key removal (single-root C6);
 * `extraKnownMarketplaces` stripping per §3.6 (user → dsh file only, never
 * the claude file).
 */
export async function removeMarketplace(deps: PathInputs, name: string): Promise<RemovedMarketplace> {
  const paths = pluginsStatePaths(deps)
  const claudePaths = claudePluginsStatePaths(deps)
  const mergedKnown = await loadMergedKnownMarketplaces(deps)
  const entry = mergedKnown.entries[name]
  if (entry === undefined) throw unknownMarketplace(name, Object.keys(mergedKnown.entries))

  // C6 cascade: uninstall every plugin installed from this marketplace,
  // with the C5 project-scope pre-flight refusing the whole remove before
  // any mutation. Individual uninstall steps skip their own C5 guard since
  // the pre-flight passed.
  const installed = (await loadMergedInstalledPlugins(deps)).file
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

  // dsh known file: a null tombstone in dual-home (§3.5); plain key removal
  // in single-root (C6 byte-parity — single-root never writes tombstones).
  const dshKnown: Record<string, KnownMarketplaceEntry | null> = await loadJsonFile(paths.knownMarketplacesFile, {})
  if (claudePaths === null) delete dshKnown[name]
  else dshKnown[name] = null
  await saveJsonFileAtomic(paths.knownMarketplacesFile, dshKnown)
  return { name, removedPlugins }
}
