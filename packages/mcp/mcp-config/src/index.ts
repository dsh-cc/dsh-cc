/**
 * MCP workspace-configuration loader (`@dsh-cc/mcp-config`).
 *
 * Parses a Claude Code-style `.mcp.json` document — the `mcpServers` map of
 * stdio / HTTP(S) / SSE server definitions — validates it (malformed input
 * throws at load), expands `${VAR}` and `${VAR:-default}` environment
 * substitutions, dedupes server names, applies an enterprise allow/deny policy,
 * and translates the accepted servers into `@dsh-cc/mcp-client`
 * registrations ready for mount.
 *
 * The package owns the file→config *reading and validation* surface only; it
 * performs no network I/O and mounts nothing itself. Consumers translate the
 * returned registrations into mcp-client plugin instances.
 *
 * Two side modules extend that surface: `src/paths.ts` adds side-effect-free
 * default-path classification and per-file server-name reads, and
 * `src/migrate.ts` is the package's only file-WRITING surface — the atomic,
 * user-invoked `/mcp migrate` import into `$DSH_HOME/.mcp.json`.
 *
 * @module @dsh-cc/mcp-config
 */

import type { Config } from '@dsh-cc/mcp-client'

/**
 * A `.mcp.json` server definition before transport normalization.
 * `stdio` servers omit `type` (the Claude Code default) or set it explicitly;
 * network servers set `http` / `sse` (or Claude Code's legacy `streamable-http`).
 */
export interface McpServerEntry {
  /** `stdio` (default when absent), `http`, or `sse`. */
  type?: 'stdio' | 'http' | 'sse' | 'streamable-http'
  /** Stdio executable (required for the stdio transport). */
  command?: string
  /** Arguments passed directly, without shell interpolation. */
  args?: string[]
  /** Extra env vars merged on top of scrubbed ambient env. */
  env?: Record<string, string>
  /** Working directory for the child process. */
  cwd?: string
  /** MCP endpoint URL (required for http/sse transports). */
  url?: string
  /** Additional headers attached to MCP requests. */
  headers?: Record<string, string>
}

/** A `.mcp.json` document body: a map (or deduping array) of server definitions. */
export type McpConfigFile =
  | { mcpServers: Record<string, McpServerEntry> }
  | { mcpServers: Array<Record<string, McpServerEntry>> }

/** A normalized mcp-client transport config, before the `serverName` is set. */
export type McpTransport =
  | {
    transport: 'stdio'
    command: string
    args: string[]
    env: Record<string, string>
    cwd: string
    toolCallTimeoutMs: number
    failOnStartupError: boolean
  }
  | {
    transport: 'streamable-http' | 'sse'
    url: string
    headers: Record<string, string>
    toolCallTimeoutMs: number
    failOnStartupError: boolean
  }

/** Named, validated, normalized server definition. */
export interface McpServerSpec {
  /** Server name from the configuration key; becomes the mcp-client `serverName`. */
  name: string
  /** Normalized client transport config (environment still unexpanded). */
  entry: McpTransport
}

/**
 * Enterprise gate over the configured servers. `deny` runs first and wins; a
 * name allowed by neither is dropped. Order is stable config order. Hooks must
 * be synchronous and total; a throwing hook aborts the whole load.
 */
export interface McpConfigPolicy {
  /** Deny a server by name/entry; returning `true` drops it. */
  deny?: (name: string, entry: McpServerEntry) => boolean
  /** Allow a server by name/entry; returning `true` keeps it (after `deny`). */
  allow?: (name: string, entry: McpServerEntry) => boolean
}

/** Whether a env lookup value counts as "set" (present and not the empty string). */
function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== ''
}

/**
 * Resolve one environment substitution in `value`: `${VAR}` requires the
 * variable to be set (throwing otherwise) and `${VAR:-default}` falls back to
 * `default` when the variable is unset or empty. Doubled `$$` escapes a literal
 * `$`. Values with neither form are returned unchanged.
 *
 * @param value - raw string possibly containing `${VAR}` / `${VAR:-default}`.
 * @param env - environment lookup; an unset key is `undefined`.
 * @returns the fully expanded string.
 */
export function expandEnv(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$\$/g, (match, name, fallback) => {
    if (match === '$$') return '$'
    const key = name as string
    const raw = env[key]
    if (isSet(raw)) return raw as string
    if (fallback !== undefined) return fallback as string
    // A present-but-empty value with no fallback expands to the empty string
    // rather than throwing; only a truly unset variable is an error.
    if (raw === '') return ''
    throw new Error(`dsh-mcp-config: environment variable "${key}" is not set`)
  })
}

/**
 * Normalize a raw server entry into an mcp-client transport config, validating
 * transport-specific required fields. Malformed entries throw at load.
 *
 * @param entry - raw `.mcp.json` server definition.
 * @returns a normalized transport config (environment not yet expanded).
 */
export function normalizeServerEntry(entry: McpServerEntry): McpTransport {
  // Widen to `string` so an at-runtime unknown transport (from a buggy or
  // future `.mcp.json`) still reaches the throwing `default` below rather than
  // being narrowed away by the closed union.
  const type: string | undefined = entry.type
  switch (type) {
    case undefined:
    case 'stdio': {
      if (typeof entry.command !== 'string' || entry.command.length === 0) {
        throw new Error('dsh-mcp-config: stdio server requires a "command"')
      }
      return {
        transport: 'stdio',
        command: entry.command,
        args: entry.args ?? [],
        env: entry.env ?? {},
        cwd: entry.cwd ?? '',
        toolCallTimeoutMs: 60_000,
        failOnStartupError: true,
      }
    }
    case 'http':
    case 'streamable-http':
      return networkConfig('streamable-http', entry)
    case 'sse':
      return networkConfig('sse', entry)
    default:
      throw new Error(`dsh-mcp-config: unsupported MCP transport "${type}"`)
  }
}

/** Build a network transport config, requiring a valid `url`. */
function networkConfig(transport: 'streamable-http' | 'sse', entry: McpServerEntry): McpTransport {
  if (typeof entry.url !== 'string' || entry.url.length === 0) {
    throw new Error(`dsh-mcp-config: ${transport} server requires a "url"`)
  }
  return {
    transport,
    url: entry.url,
    headers: entry.headers ?? {},
    toolCallTimeoutMs: 60_000,
    failOnStartupError: true,
  }
}

/** Expand every env substitution inside one normalized transport config. */
function expandConfig(config: McpTransport, env: Record<string, string | undefined>): McpTransport {
  if (config.transport === 'stdio') {
    return {
      ...config,
      command: expandEnv(config.command, env),
      args: config.args.map(a => expandEnv(a, env)),
      env: Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, expandEnv(v, env)])),
      cwd: expandEnv(config.cwd, env),
    }
  }
  return {
    ...config,
    url: expandEnv(config.url, env),
    headers: Object.fromEntries(Object.entries(config.headers).map(([k, v]) => [k, expandEnv(v, env)])),
  }
}

/**
 * Expand environment substitutions in a normalized server entry.
 * @param entry - a normalized transport config before expansion.
 * @param env - environment lookup; defaults to `process.env`.
 * @returns a new config with every `${...}` substitution resolved.
 */
export function applyEnv(entry: McpTransport, env: Record<string, string | undefined> = process.env): McpTransport {
  return expandConfig(entry, env)
}

/**
 * Read and validate the `mcpServers` map from a `.mcp.json` body.
 * @param body - parsed JSON document (or its `mcpServers` value).
 * @returns the raw name→entry map, validated.
 */
export function parseMcpServers(body: unknown): Record<string, McpServerEntry> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('dsh-mcp-config: config body must be an object')
  }
  const servers = (body as { mcpServers?: unknown }).mcpServers
  if (servers === undefined) throw new Error('dsh-mcp-config: config must declare "mcpServers"')
  const map: Record<string, McpServerEntry> = {}
  if (Array.isArray(servers)) {
    for (const group of servers) {
      if (group === null || typeof group !== 'object' || Array.isArray(group)) {
        throw new Error('dsh-mcp-config: each mcpServers array entry must be a name→definition object')
      }
      for (const [name, entry] of Object.entries(group as Record<string, McpServerEntry>)) {
        if (Object.hasOwn(map, name)) throw new Error(`dsh-mcp-config: duplicate server name "${name}"`)
        map[name] = entry
      }
    }
    return map
  }
  if (typeof servers !== 'object' || servers === null) {
    throw new Error('dsh-mcp-config: "mcpServers" must be an object or array of objects')
  }
  Object.assign(map, servers)
  return map
}

/**
 * Normalize a parsed server map into a stable ordered list. The map form cannot
 * contain duplicate keys, so this is primarily the revalidation/normalization
 * pass that also feeds environment expansion.
 * @param servers - validated name→entry map.
 * @returns `[name, normalized spec]` pairs in stable order.
 */
export function dedupServers(servers: Record<string, McpServerEntry>): McpServerSpec[] {
  const specs: McpServerSpec[] = []
  for (const [name, entry] of Object.entries(servers)) {
    specs.push({ name, entry: normalizeServerEntry(entry) })
  }
  return specs
}

/** Recover the original raw entry for policy hooks. */
function findOriginal(name: string, body: McpConfigFile): McpServerEntry | undefined {
  const servers = body.mcpServers
  if (Array.isArray(servers)) {
    for (const group of servers) if (Object.hasOwn(group, name)) return group[name]
    return undefined
  }
  return servers[name]
}

/**
 * Collapse a Claude Code server name into the mcp-client `[A-Za-z0-9_-]{1,32}` tool-prefix contract.
 */
export function normalizeServerName(name: string): string {
  const normalized = name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  // An all-invalid-char name would collapse to '' — fall back to a dash so the pattern still matches.
  return normalized === '' ? '-' : normalized
}

/**
 * Full pipeline: parse, validate, expand environment, dedupe, apply policy,
 * and translate to mcp-client registrations. Malformed or unknown input throws
 * at load; policy rejects are dropped silently in stable config order.
 * @param body - parsed `.mcp.json` body.
 * @param options - env lookups and enterprise policy.
 * @returns accepted servers as mcp-client `Config` objects (with `serverName`).
 */
export function buildRegistrations(
  body: McpConfigFile,
  options: { env?: Record<string, string | undefined>; policy?: McpConfigPolicy; deferStartupConnect?: boolean } = {},
): Config[] {
  const env = options.env ?? process.env
  const configs: Config[] = []
  for (const { name, entry: raw } of dedupServers(parseMcpServers(body))) {
    const original = findOriginal(name, body) ?? {}
    if (options.policy?.deny?.(name, original) === true) continue
    if (options.policy?.allow !== undefined && !options.policy.allow(name, original)) continue
    const expanded = expandConfig(raw, env)
    // Policy hooks and findOriginal above see the ORIGINAL name; only the
    // emitted mcp-client `serverName` (the tool-name prefix) is normalized.
    // `deferStartupConnect` opts the caller into non-blocking mounts; because
    // fail-fast startup forces fully blocking behavior in mcp-client, the
    // deferral also downgrades the normalized `failOnStartupError: true` so
    // the two flags never contradict each other.
    configs.push({
      ...expanded,
      serverName: normalizeServerName(name),
      ...(options.deferStartupConnect === true
        ? { deferStartupConnect: true, failOnStartupError: false }
        : {}),
    })
  }
  return configs
}

export type { Config }

export {
  claudeOnlyServers,
  readMcpServerNames,
  resolveDefaultMcpPaths,
} from './paths.ts'
export type { ClaudeOnlySource, McpPathInputs, McpServerNames, ResolvedMcpPaths } from './paths.ts'
export { migrateMcpServers } from './migrate.ts'
export type { McpMigrationResult, McpMigrationSourceReport } from './migrate.ts'
