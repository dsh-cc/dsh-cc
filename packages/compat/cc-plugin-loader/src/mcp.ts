/**
 * Mount a Claude Code plugin's MCP servers.
 *
 * Collects server definitions from the manifest inline `mcpServers` record or
 * an `.mcp.json` file, then registers each through the optional `mcp` guest
 * seam. Tool naming (`mcp__<server>__<tool>`) is the seam's responsibility.
 * When the seam is absent the component is reported skipped, never failed.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import type { CcPluginManifest } from './types.ts'
import { ComponentTally } from './seams.ts'

/** The MCP seam: registers a named server for tool discovery. */
export interface McpSeam {
  /**
   * Register one MCP server.
   * @param name - unique server name.
   * @param config - server transport configuration.
   * @returns the exact disposer that unregisters the server.
   */
  registerServer(name: string, config: Record<string, unknown>): () => void
}

/** Options for mounting one plugin's MCP servers. */
export interface MountMcpServersOptions {
  /** The plugin root directory; an `.mcp.json` path resolves against it. */
  readonly pluginRoot: string
  /** The parsed manifest; `mcpServers` and `mcpServersPath` drive the mount. */
  readonly manifest: CcPluginManifest
  /** The mcp seam (probed; `undefined` to skip mcpServers). */
  readonly mcp: McpSeam | undefined
}

/**
 * Collect and register a plugin's MCP servers through the optional seam.
 * @param options - plugin root, manifest, and the mcp seam.
 * @returns mounted disposers and per-component counts.
 */
export function mountMcpServers(options: MountMcpServersOptions): { disposers: (() => void)[]; tally: ComponentTally; warnings: string[] } {
  const tally = new ComponentTally('mcpServers')
  const disposers: (() => void)[] = []
  const warnings: string[] = []
  if (options.mcp === undefined) {
    tally.addSkipped('mcp seam "mcp" is not mounted')
    return { disposers, tally, warnings }
  }
  const servers = collectServers(options.pluginRoot, options.manifest)
  // Cursor default layout (plan §3.2): a root `mcp.json` is discovered when the
  // manifest declares nothing. CC-flavored behavior is untouched.
  if (options.manifest.flavor === 'cursor' && manifestDeclaresNothing(options.manifest)) {
    Object.assign(servers, readMcpJson(join(options.pluginRoot, 'mcp.json')))
  }
  const entries = Object.entries(servers)
  if (entries.length === 0) {
    tally.addSkipped('plugin declares no MCP servers')
    return { disposers, tally, warnings }
  }
  const cursor = options.manifest.flavor === 'cursor'
  for (const [name, config] of entries) {
    const prepared = cursor ? prepareCursorServer(name, config, options.pluginRoot, tally, warnings) : config
    if (prepared === undefined) continue // skipped with reason/warning already recorded
    disposers.push(options.mcp.registerServer(name, prepared))
    tally.addLoaded()
  }
  return { disposers, tally, warnings }
}

/**
 * Cursor-dialect server preparation (plan §3.2): expand `${CURSOR_PLUGIN_ROOT}`
 * to the plugin root, then require every remaining `${VAR}` to resolve against
 * the environment — an unresolved reference fails THAT server with a warning
 * naming the variable (never the whole plugin, never silent empty expansion).
 * Returns `undefined` when the server was skipped.
 */
function prepareCursorServer(
  name: string,
  config: Record<string, unknown>,
  pluginRoot: string,
  tally: ComponentTally,
  warnings: string[],
): Record<string, unknown> | undefined {
  const substituted = JSON.parse(JSON.stringify(config).split('${CURSOR_PLUGIN_ROOT}').join(pluginRoot)) as Record<string, unknown>
  const missing = new Set<string>()
  collectUnresolvedVars(substituted, missing)
  if (missing.size > 0) {
    const reason = `skipped mcp server "${name}": environment variable${missing.size === 1 ? '' : 's'} "${[...missing].join('", "')}" not set`
    tally.addSkipped(reason)
    warnings.push(reason)
    return undefined
  }
  return substituteEnv(substituted) as Record<string, unknown>
}

/** Interpolate resolved `${VAR}` / `${VAR:-default}` references into string values. */
function substituteEnv(node: unknown): unknown {
  if (typeof node === 'string') {
    return node.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match, name: string, fallback?: string) => {
      const value = process.env[name]
      if (value !== undefined && value !== '') return value
      if (fallback !== undefined) return fallback
      return match // unreachable for validated configs; keep the reference visible
    })
  }
  if (Array.isArray(node)) return node.map(substituteEnv)
  if (typeof node === 'object' && node !== null) {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, substituteEnv(value)]))
  }
  return node
}

/** Collect `${VAR}` references with no value in the environment (fallbacks count as resolved). */
function collectUnresolvedVars(node: unknown, missing: Set<string>): void {
  if (typeof node === 'string') {
    for (const match of node.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) {
      const variable = match[1] as string
      if (match[2] === undefined && process.env[variable] === undefined) missing.add(variable)
    }
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) collectUnresolvedVars(item, missing)
    return
  }
  if (typeof node === 'object' && node !== null) {
    for (const value of Object.values(node)) collectUnresolvedVars(value, missing)
  }
}

/** Whether the manifest stayed silent about mcpServers entirely. */
function manifestDeclaresNothing(manifest: CcPluginManifest): boolean {
  return manifest.mcpServersPath === undefined && manifest.mcpServersPaths === undefined
    && Object.keys(manifest.mcpServers).length === 0
}

/** Combine inline and file-backed MCP server definitions. */
function collectServers(pluginRoot: string, manifest: CcPluginManifest): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {}
  if (manifest.mcpServersPath !== undefined) {
    const path = resolve(pluginRoot, manifest.mcpServersPath)
    Object.assign(servers, readMcpJson(path))
  }
  for (const path of manifest.mcpServersPaths ?? []) {
    Object.assign(servers, readMcpJson(resolve(pluginRoot, path)))
  }
  for (const [name, config] of Object.entries(manifest.mcpServers)) {
    servers[name] = config as Record<string, unknown>
  }
  return servers
}

/** Read an `.mcp.json` file's `mcpServers` key (absent/invalid yields none). */
function readMcpJson(path: string): Record<string, Record<string, unknown>> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const servers = parsed['mcpServers']
    if (typeof servers === 'object' && servers !== null && !Array.isArray(servers)) {
      return servers as Record<string, Record<string, unknown>>
    }
    return {}
  } catch {
    return {}
  }
}
