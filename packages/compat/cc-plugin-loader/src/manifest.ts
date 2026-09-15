/**
 * Parse the Claude Code `plugin.json` manifest subset this loader consumes.
 *
 * Validation happens on the raw manifest object at load time: a malformed
 * manifest (wrong types, a blank or space-containing plugin name, an unreadable
 * file) throws with the plugin name so the failure is actionable. Component
 * fields accept the union shapes Claude Code allows (single path, array, or
 * object map for commands) and are normalized to the loader's typed view.
 * Unknown top-level fields are ignored, matching Claude Code's tolerant
 * top-level handling.
 *
 * @module
 */

import type { CcPluginManifest, CcCommand, CcMcpServer, PluginFlavor } from './types.ts'

/** Extra flags the resolver threads in (not authored in plugin.json). */
export interface ParsePluginManifestOptions {
  /** Marketplace-root overlay: listed `skills` replace the default `skills/` scan. */
  readonly skillsReplaceDefault?: boolean
  /** Dialect of the winning manifest candidate (resolver-injected, plan §3.1). */
  readonly flavor?: PluginFlavor
  /** Resolution warnings to carry on the parsed manifest (S2 promotes to report). */
  readonly warnings?: readonly string[]
}

/**
 * Validate a raw `plugin.json` object into the loader's typed manifest subset.
 * @param raw - the parsed JSON contents of `plugin.json`.
 * @param source - the plugin name or path used to prefix validation errors.
 * @param options - resolver flags that are not authored in the JSON.
 * @returns the normalized manifest subset.
 * @throws when the manifest is structurally invalid.
 */
export function parsePluginManifest(
  raw: unknown,
  source: string,
  options: ParsePluginManifestOptions = {},
): CcPluginManifest {
  if (!isRecord(raw)) {
    throw new Error(`plugin ${source}: manifest must be a JSON object`)
  }
  const name = readName(raw['name'], source)
  const commands = normalizeCommands(raw['commands'], name)
  const agents = normalizeStringList(raw['agents'], name, 'agents')
  const skills = normalizeStringList(raw['skills'], name, 'skills')
  // Cursor default-dir inference (plan §3.2 component conventions): an
  // undeclared `rules` still scans `rules/`, as with the implicit dirs.
  const rules = normalizeRules(raw['rules'] ?? ((options.flavor ?? 'cc') === 'cursor' ? 'rules' : undefined), name)
  const { mcpServers, mcpServersPath } = normalizeMcpServers(raw['mcpServers'], name)
  const settings = isRecord(raw['settings']) ? raw['settings'] : {}
  // Cursor-dialect tolerance warnings (plan §3.4): metadata fields are silently
  // tolerated, but these two degrade silently unless surfaced.
  const dialectWarnings = (options.flavor ?? 'cc') === 'cursor'
    ? [
      ...raw['minClientVersions'] !== undefined ? ['client-version gating is not enforced'] : [],
      ...raw['variables'] !== undefined ? ['plugin variables are not prompted; set values via environment'] : [],
    ]
    : []
  return {
    name,
    flavor: options.flavor ?? 'cc',
    warnings: [...options.warnings ?? [], ...dialectWarnings],
    ...typeof raw['version'] === 'string' ? { version: raw['version'] } : {},
    ...typeof raw['description'] === 'string' ? { description: raw['description'] } : {},
    ...raw['author'] !== undefined ? { author: raw['author'] } : {},
    commands,
    commandsDeclared: raw['commands'] !== undefined,
    agents,
    skills,
    rules,
    skillsReplaceDefault: options.skillsReplaceDefault === true,
    ...raw['hooks'] !== undefined ? { hooks: raw['hooks'] } : {},
    mcpServers,
    ...mcpServersPath !== undefined ? { mcpServersPath } : {},
    settings,
  }
}

/** A manifest command entry as authored inline in the `commands` record. */
interface CommandEntry {
  readonly source?: string
  readonly content?: string
  readonly description?: string
  readonly argumentHint?: string
  readonly model?: string
  readonly allowedTools?: readonly string[]
}

/** Require and validate the mandatory plugin `name`. */
function readName(raw: unknown, source: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`plugin ${source}: "name" must be a non-empty string`)
  }
  if (raw.includes(' ')) {
    throw new Error(`plugin ${raw}: "name" cannot contain spaces; use kebab-case`)
  }
  return raw
}

function normalizeCommands(raw: unknown, name: string): CcCommand[] {
  if (raw === undefined) return []
  if (typeof raw === 'string') return [{ name, source: raw }]
  if (isStringArray(raw)) return raw.map(path => ({ name, source: path }))
  if (isRecord(raw)) {
    return Object.entries(raw).map(([commandName, meta]) => {
      if (!isRecord(meta)) throw new Error(`plugin ${name}: command "${commandName}" must be an object`)
      const entry = commandEntry(meta, name, commandName)
      return { name: commandName, ...entry }
    })
  }
  throw new Error(`plugin ${name}: "commands" must be a path, a list, or an object map`)
}

/** Validate one inline command metadata record; `source` and `content` are exclusive. */
function commandEntry(meta: Record<string, unknown>, name: string, commandName: string): CommandEntry {
  const hasSource = typeof meta['source'] === 'string'
  const hasContent = typeof meta['content'] === 'string'
  if (hasSource === hasContent) {
    throw new Error(`plugin ${name}: command "${commandName}" must provide exactly one of "source" (path) or "content" (inline)`)
  }
  const entry: MutableCommandEntry = {}
  if (hasSource) entry.source = meta['source'] as string
  if (hasContent) entry.content = meta['content'] as string
  for (const key of ['description', 'argumentHint', 'model'] as const) {
    if (typeof meta[key] === 'string') entry[key] = meta[key]
  }
  if (Array.isArray(meta['allowedTools'])) {
    entry.allowedTools = meta['allowedTools'] as string[]
  }
  return entry
}

/** Mutable accumulator mirroring {@link CommandEntry} for stepwise construction. */
interface MutableCommandEntry extends CommandEntry {
  source?: string
  content?: string
  description?: string
  argumentHint?: string
  model?: string
  allowedTools?: readonly string[]
}

function normalizeStringList(raw: unknown, name: string, field: string): string[] {
  if (raw === undefined) return []
  if (typeof raw === 'string') return [raw]
  if (isStringArray(raw)) return [...raw]
  throw new Error(`plugin ${name}: "${field}" must be a path or a list of paths`)
}

/** Rules accept stringOrArray only — the Cursor schema has no map form. */
function normalizeRules(raw: unknown, name: string): string[] {
  if (raw === undefined) return []
  if (typeof raw === 'string') return [raw]
  if (isStringArray(raw)) return [...raw]
  throw new Error(`plugin ${name}: "rules" must be a path or a list of paths; a map form is not supported`)
}

function normalizeMcpServers(raw: unknown, name: string): {
  mcpServers: Readonly<Record<string, CcMcpServer>>
  mcpServersPath?: string
  mcpServersPaths?: string[]
} {
  if (raw === undefined) return { mcpServers: {} }
  if (typeof raw === 'string') return { mcpServers: {}, mcpServersPath: raw } // an `.mcp.json` path
  if (isRecord(raw)) return { mcpServers: raw as Readonly<Record<string, CcMcpServer>> }
  // Cursor array form (plan §3.4): elements are `.mcp.json` paths or inline records.
  if (Array.isArray(raw)) {
    const servers: Record<string, CcMcpServer> = {}
    const paths: string[] = []
    for (const item of raw) {
      if (typeof item === 'string') paths.push(item)
      else if (isRecord(item)) Object.assign(servers, item as Record<string, CcMcpServer>)
      else throw new Error(`plugin ${name}: "mcpServers" array elements must be a path or an object map`)
    }
    return {
      mcpServers: servers,
      // Single path keeps the existing seam; multiple use the plural field.
      ...paths.length === 1 ? { mcpServersPath: paths[0] } : {},
      ...paths.length > 0 ? { mcpServersPaths: paths } : {},
    }
  }
  throw new Error(`plugin ${name}: "mcpServers" must be a path, a list of paths/objects, or an object map`)
}

/**
 * Classify a manifest component path against the v1 glob policy (plan §3.4):
 * `dir/**` is directory-recursive, any other glob metacharacter is unsupported
 * (skipped with a warning, never expanded), everything else is literal.
 */
export function globPathKind(path: string): 'literal' | 'recursive' | 'unsupported' {
  if (path.endsWith('/**')) return 'recursive'
  return /[*?[]/.test(path) ? 'unsupported' : 'literal'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}
