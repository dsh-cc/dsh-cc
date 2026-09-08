/**
 * Plugin id parsing and resolution against installed keys: an argument is
 * either an exact `<name>@<marketplace>` id or a bare `<name>` that resolves
 * iff exactly one installed key has that name part (plan §3 "Install id
 * resolution"). Errors carry the exact catalog strings from errors.ts.
 *
 * The not-yet-installed variant against marketplace declarations is S3/S4.
 *
 * @module @dsh-cc/plugin-manager/resolve-id
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ambiguousPluginName,
  marketplaceManifestMissing,
  marketplacePluginNotDeclared,
  pluginNotInstalled,
  unknownDeclaredPlugin,
  unknownMarketplace,
  unknownPlugin,
  unsupportedPluginSource,
} from './errors.ts'
import { loadMergedKnownMarketplaces } from './merged-state.ts'
import type { PathInputs } from './paths.ts'

export interface ParsedPluginId {
  name: string
  marketplace?: string
}

/** Split `<name>` / `<name>@<marketplace>` (the marketplace part is everything after the LAST `@`). */
export function parsePluginId(arg: string): ParsedPluginId {
  const idx = arg.lastIndexOf('@')
  if (idx <= 0) return { name: arg }
  return { name: arg.slice(0, idx), marketplace: arg.slice(idx + 1) }
}

/**
 * Resolve an id-or-name argument against the installed plugin keys.
 * An exact key match wins; a bare name resolves iff exactly one installed
 * key has that name part.
 */
export function resolveInstalledPluginId(arg: string, installedKeys: readonly string[]): string {
  if (installedKeys.includes(arg)) return arg
  const { name, marketplace } = parsePluginId(arg)
  if (marketplace !== undefined) throw pluginNotInstalled(arg)
  const matches = installedKeys.filter(key => parsePluginId(key).name === name)
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) throw unknownPlugin(arg, installedKeys)
  throw ambiguousPluginName(name, matches)
}

/**
 * Resolve an id-or-name argument against the plugin ids each known
 * marketplace declares (S4 install resolution): an exact `<name>@<mkt>`
 * must be declared by that marketplace; a bare `<name>` resolves iff
 * exactly one declared id has that name part.
 */
export function resolveDeclaredPluginId(arg: string, declaredByMarketplace: ReadonlyMap<string, readonly string[]>): string {
  const { name, marketplace } = parsePluginId(arg)
  if (marketplace !== undefined) {
    const declared = declaredByMarketplace.get(marketplace) ?? []
    if (declared.includes(arg)) return arg
    throw marketplacePluginNotDeclared(marketplace, name)
  }
  const matches: string[] = []
  const all: string[] = []
  for (const ids of declaredByMarketplace.values()) {
    for (const id of ids) {
      all.push(id)
      if (parsePluginId(id).name === name) matches.push(id)
    }
  }
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) throw unknownDeclaredPlugin(name, all)
  throw ambiguousPluginName(name, matches)
}

/** One plugin declared by a marketplace manifest: only string (directory) sources in v1. */
export interface DeclaredPlugin {
  name: string
  source: string
}

/**
 * Read `<installLocation>/.claude-plugin/marketplace.json` and return the
 * declared plugins. Object (non-string) sources are rejected with the
 * unsupported-source error; a missing/unreadable manifest surfaces the S3
 * manifest-missing error.
 */
export async function readDeclaredPlugins(deps: PathInputs, marketplaceName: string): Promise<DeclaredPlugin[]> {
  // Merged known map (§3.2): a claude-known marketplace's declarations are
  // readable for install/update; its clone is only ever read.
  const known = (await loadMergedKnownMarketplaces(deps)).entries
  const entry = known[marketplaceName]
  if (entry === undefined) throw unknownMarketplace(marketplaceName, Object.keys(known))
  const dir = entry.installLocation
  let raw: string
  try {
    raw = await readFile(join(dir, '.claude-plugin', 'marketplace.json'), 'utf8')
  } catch (error) {
    throw marketplaceManifestMissing(dir, (error as NodeJS.ErrnoException).code ?? (error as Error).message)
  }
  let manifest: { plugins?: unknown }
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    throw marketplaceManifestMissing(dir, (error as Error).message)
  }
  const plugins = Array.isArray(manifest['plugins']) ? manifest['plugins'] : []
  const declared: DeclaredPlugin[] = []
  for (const item of plugins) {
    const name = (item as Record<string, unknown> | null)?.['name']
    if (typeof name !== 'string' || name.length === 0) continue
    const source = (item as Record<string, unknown>)['source']
    if (typeof source !== 'string') throw unsupportedPluginSource(`${name}@${marketplaceName}`)
    declared.push({ name, source })
  }
  return declared
}
