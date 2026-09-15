/**
 * Resolve the raw JSON a plugin root should load as its manifest.
 *
 * Preference: `.claude-plugin/plugin.json`, then top-level `plugin.json`, then
 * a matching `marketplace.json` overlay (requires `nameHint`), then a
 * synthesized `{ name }` so a truly optional manifest still mounts default
 * component dirs. A marketplace file with no matching entry is a hard miss —
 * never fall through to synthesis (that would load the whole skills repo).
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  CURSOR_MANIFEST as CURSOR_DIR,
  MANIFEST_CANDIDATE_DIRS,
  MARKETPLACE_CANDIDATE_FILES,
  TOP_LEVEL_MANIFEST,
} from './discovery.ts'
import type { PluginFlavor } from './types.ts'

/** Resolved raw manifest plus the marketplace replace-default flag. */
export interface ResolvedPluginManifest {
  /** JSON object to feed `parsePluginManifest`. */
  readonly raw: unknown
  /** When true, listed `skills` replace the default `skills/` scan. */
  readonly skillsReplaceDefault: boolean
  /** Which dialect won the candidate lookup (plan §3.1). */
  readonly flavor: PluginFlavor
  /** Resolution warnings (e.g. dual-manifest precedence); travels on the parsed manifest. */
  readonly warnings: readonly string[]
}

/** Flavor of the winning candidate path: cc dirs/top-level → 'cc', cursor dir → 'cursor'. */
function flavorOf(manifestPath: string): PluginFlavor {
  return manifestPath.includes(CURSOR_DIR) ? 'cursor' : 'cc'
}

/**
 * Locate and return the raw manifest for one plugin root.
 *
 * Preference (plan §3.1): `.claude-plugin/plugin.json`, then
 * `.cursor-plugin/plugin.json`, then top-level `plugin.json`, then a matching
 * `marketplace.json` overlay (requires `nameHint`), then a synthesized
 * `{ name }`. When both nested manifests exist the CC manifest wins and a
 * precedence warning is recorded. A marketplace file with no matching entry is
 * a hard miss — never fall through to synthesis (that would load the whole
 * skills repo).
 *
 * @param root - plugin root directory.
 * @param nameHint - installed plugin name (no `@marketplace`), for overlays.
 * @returns the raw JSON, flavor, and resolution warnings.
 * @throws when a present file is unreadable/invalid, or a marketplace overlay misses `nameHint`.
 */
export function resolvePluginManifest(root: string, nameHint?: string): ResolvedPluginManifest {
  const candidates = MANIFEST_CANDIDATE_DIRS.map(dir => join(root, dir, TOP_LEVEL_MANIFEST))
  const items = candidates.map(path => ({ path, raw: readJsonIfPresent(path, root) }))
  const winner = items.find(item => item.raw !== undefined)
  if (winner !== undefined) {
    return {
      raw: winner.raw,
      skillsReplaceDefault: false,
      flavor: flavorOf(winner.path),
      // S2 promotes this carrier into the first-class report warnings array.
      warnings: items.filter(item => item.raw !== undefined).length > 1
        ? ['cursor manifest ignored: cc manifest takes precedence']
        : [],
    }
  }
  const top = readJsonIfPresent(join(root, TOP_LEVEL_MANIFEST), root)
  if (top !== undefined) return { raw: top, skillsReplaceDefault: false, flavor: 'cc', warnings: [] }
  for (const file of MARKETPLACE_CANDIDATE_FILES) {
    const market = readJsonIfPresent(join(root, file), root)
    if (market === undefined) continue
    return { ...overlayFromMarketplace(market, root, nameHint), flavor: 'cc', warnings: [] }
  }
  const name = nameHint ?? basename(resolve(root))
  return { raw: { name }, skillsReplaceDefault: false, flavor: 'cc', warnings: [] }
}

/** Marketplace.json present: match `nameHint` or fail; never synthesize. */
function overlayFromMarketplace(raw: unknown, root: string, nameHint: string | undefined): Pick<ResolvedPluginManifest, 'raw' | 'skillsReplaceDefault'> {
  if (nameHint === undefined) {
    throw new Error(`plugin ${root}: marketplace.json is not a plugin root without a name hint`)
  }
  if (!isRecord(raw) || !Array.isArray(raw['plugins'])) {
    throw new Error(`plugin ${root}: marketplace.json has no plugins array`)
  }
  const entry = raw['plugins'].find(item => isRecord(item) && item['name'] === nameHint)
  if (!isRecord(entry)) {
    throw new Error(`plugin ${root}: marketplace.json has no plugin named "${nameHint}"`)
  }
  return { raw: synthesizeFromMarketplace(entry, nameHint), skillsReplaceDefault: true }
}

/** Lift a marketplace `plugins[]` entry into a plugin.json-shaped object. */
function synthesizeFromMarketplace(entry: Record<string, unknown>, nameHint: string): Record<string, unknown> {
  const name = typeof entry['name'] === 'string' && entry['name'].length > 0 ? entry['name'] : nameHint
  const out: Record<string, unknown> = { name }
  for (const key of ['version', 'description', 'author', 'commands', 'agents', 'skills', 'hooks', 'mcpServers', 'settings'] as const) {
    if (entry[key] !== undefined) out[key] = entry[key]
  }
  return out
}

/** Read and parse JSON; missing files are `undefined`, anything else throws. */
function readJsonIfPresent(path: string, root: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (isEnoent(error)) return undefined
    throw new Error(`plugin ${root}: could not read ${path}: ${String(error)}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`plugin ${root}: invalid JSON in ${path}: ${String(error)}`)
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
