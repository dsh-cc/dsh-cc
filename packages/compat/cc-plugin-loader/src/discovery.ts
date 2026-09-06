/**
 * Discover Claude Code plugin roots the way Claude Code actually installs them.
 *
 * Default (no `pluginDirs`): the intersection of `enabledPlugins` across the
 * user/project/local settings cascade and `installed_plugins.json`. Explicit
 * `pluginDirs` keeps the historical flatten (a root, or its one-level
 * children, that hold `plugin.json` or `.claude-plugin/plugin.json`). Empty
 * or null `pluginDirs` disables discovery. Best-effort: unreadable files and
 * missing install paths skip rather than throw.
 *
 * @module
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { resolveLocalSettingsDir } from '@dsh-cc/settings-cascade/local-root'

/** One discovered plugin root plus the name used to match marketplace overlays. */
export interface DiscoveredCcPlugin {
  /** Absolute plugin root (the directory that holds the manifest / components). */
  readonly root: string
  /** Plugin name without `@marketplace`, used as a marketplace-entry hint. */
  readonly nameHint: string
}

/** Options for one discovery pass. */
export interface DiscoverCcPluginRootsOptions {
  /**
   * Explicit discovery roots. `undefined` (absent) uses installed ∩ enabled;
   * `[]` or `null` disables discovery; a non-empty list flattens those dirs.
   */
  readonly pluginDirs?: readonly string[] | null
  /** Claude config home; defaults to `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
  readonly claudeHome?: string
  /** Workspace used for project/local `enabledPlugins`; defaults to `process.cwd()`. */
  readonly cwd?: string
  /** Optional logger for project-scope cwd and skipped bare enablement keys. */
  readonly log?: { info(message: string): void; warn(message: string): void }
}

/** Nested Claude Code manifest path, preferred over a top-level `plugin.json`. */
export const NESTED_MANIFEST = join('.claude-plugin', 'plugin.json')

/** Legacy / fixture manifest path at the plugin root. */
export const TOP_LEVEL_MANIFEST = 'plugin.json'

/**
 * Discover plugin roots for the glue to mount.
 * @param options - explicit dirs or the Claude-home / cwd pair for the default path.
 * @returns unique `{ root, nameHint }` entries, in discovery order.
 */
export function discoverCcPluginRoots(options: DiscoverCcPluginRootsOptions = {}): DiscoveredCcPlugin[] {
  if (options.pluginDirs === null || isEmptyList(options.pluginDirs)) return []
  if (options.pluginDirs !== undefined) return flattenPluginDirs(options.pluginDirs)
  return discoverInstalledEnabled(
    resolveClaudeHome(options.claudeHome),
    options.cwd ?? process.cwd(),
    options.log,
  )
}

/** True when an explicit `pluginDirs` list is present and empty. */
function isEmptyList(value: readonly string[] | undefined): boolean {
  return value !== undefined && value.length === 0
}

/** `$CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude`. */
export function resolveClaudeHome(explicit?: string): string {
  if (explicit !== undefined) return explicit
  const fromEnv = process.env.CLAUDE_CONFIG_DIR
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.claude')
}

/** Flatten configured dirs: the dir itself, or one-level children that look like plugin roots. */
function flattenPluginDirs(dirs: readonly string[]): DiscoveredCcPlugin[] {
  const found: DiscoveredCcPlugin[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    const hint = nameHintFromRoot(dir)
    if (hint !== undefined) {
      pushUnique(found, seen, dir, hint)
      continue
    }
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const child = join(dir, entry.name)
        const childHint = nameHintFromRoot(child)
        if (childHint !== undefined) pushUnique(found, seen, child, childHint)
      }
    } catch {
      // Best-effort: an unreadable discovery root contributes nothing.
    }
  }
  return found
}

/**
 * Manifest `name` when a nested or top-level plugin.json is present.
 * Missing files are not a plugin root; unreadable/invalid JSON still is (basename fallback).
 */
function nameHintFromRoot(dir: string): string | undefined {
  for (const file of [NESTED_MANIFEST, TOP_LEVEL_MANIFEST]) {
    const text = readText(join(dir, file))
    if (text === undefined) continue
    const parsed = parseJson(text)
    if (isRecord(parsed) && typeof parsed['name'] === 'string' && parsed['name'].length > 0) return parsed['name']
    return basename(resolve(dir))
  }
  return undefined
}

/** Default path: enabledPlugins cascade ∩ installed_plugins.json. */
function discoverInstalledEnabled(
  claudeHome: string,
  cwd: string,
  log?: { info(message: string): void; warn(message: string): void },
): DiscoveredCcPlugin[] {
  const enabled = enabledKeys(claudeHome, cwd, log)
  const installed = readInstalled(join(claudeHome, 'plugins', 'installed_plugins.json'))
  const found: DiscoveredCcPlugin[] = []
  const seen = new Set<string>()
  for (const key of enabled) {
    const picked = installed[key]
    if (picked === undefined || !isDirectory(picked)) continue
    pushUnique(found, seen, picked, key.slice(0, key.indexOf('@')))
  }
  return found
}

/** Keys whose cascaded `enabledPlugins` value is JSON `true`, in first-seen order. */
function enabledKeys(
  claudeHome: string,
  cwd: string,
  log?: { info(message: string): void; warn(message: string): void },
): string[] {
  const cascade: { path: string; scope: 'user' | 'project' }[] = [
    { path: join(claudeHome, 'settings.json'), scope: 'user' },
    { path: join(cwd, '.claude', 'settings.json'), scope: 'project' },
    {
      // Claude Code-parity: the *local* settings file is read from the git
      // main checkout root (linked worktree) or git toplevel (subdirectory
      // start); the project settings above stay at the launch cwd.
      path: join(resolveLocalSettingsDir(cwd), '.claude', 'settings.local.json'),
      scope: 'project',
    },
  ]
  const state = new Map<string, boolean>()
  const order: string[] = []
  let projectScoped = false
  for (const file of cascade) {
    const parsed = readJson(file.path)
    if (!isRecord(parsed)) continue
    const block = parsed['enabledPlugins']
    if (!isRecord(block)) continue
    if (file.scope === 'project' && Object.keys(block).length > 0) projectScoped = true
    for (const [key, value] of Object.entries(block)) {
      if (typeof value !== 'boolean') continue
      if (!state.has(key)) order.push(key)
      state.set(key, value)
    }
  }
  if (projectScoped) log?.info(`cc-plugin-loader: project-scope enabledPlugins read from cwd ${cwd}`)
  const enabled: string[] = []
  for (const key of order) {
    if (state.get(key) !== true) continue
    if (!key.includes('@')) {
      log?.warn(`cc-plugin-loader: skipping bare enabledPlugins key "${key}" (expected name@marketplace)`)
      continue
    }
    enabled.push(key)
  }
  return enabled
}

/** Winning `installPath` per `name@marketplace` (latest lastUpdated, then later array element). */
function readInstalled(path: string): Record<string, string> {
  const parsed = readJson(path)
  if (!isRecord(parsed)) return {}
  const plugins = parsed['plugins']
  if (!isRecord(plugins)) return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(plugins)) {
    if (!Array.isArray(raw)) continue
    const picked = pickInstallPath(raw)
    if (picked !== undefined) out[key] = picked
  }
  return out
}

function pickInstallPath(raw: unknown[]): string | undefined {
  let best: { path: string; time: number; index: number } | undefined
  for (const [index, item] of raw.entries()) {
    if (!isRecord(item) || typeof item['installPath'] !== 'string') continue
    const candidate = { path: item['installPath'], time: parseTime(item['lastUpdated']), index }
    if (best === undefined || candidate.time > best.time || (candidate.time === best.time && candidate.index > best.index)) {
      best = candidate
    }
  }
  return best?.path
}

function parseTime(value: unknown): number {
  if (typeof value !== 'string') return Number.NEGATIVE_INFINITY
  const time = Date.parse(value)
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time
}

function pushUnique(found: DiscoveredCcPlugin[], seen: Set<string>, root: string, nameHint: string): void {
  const resolved = resolve(root)
  if (seen.has(resolved)) return
  seen.add(resolved)
  found.push({ root: resolved, nameHint })
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function readJson(path: string): unknown {
  const text = readText(path)
  return text === undefined ? undefined : parseJson(text)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
