/**
 * Pure `/mcp` parsing and rendering helpers. Input tokenization and connection
 * formatting live here so they are unit-testable without cordis or an
 * mcpConnections seam.
 * @module @dsh-cc/command-mcp
 */

import type { ClaudeOnlySource, McpMigrationResult } from '@dsh-cc/mcp-config'

/** The connection lifecycle state of one MCP server. */
export type McpConnectionState = 'connecting' | 'ready' | 'error' | 'disconnected'

/** A public snapshot of one registered MCP server. */
export interface McpConnectionEntry {
  /** The mcp-client `serverName` this instance bridges. */
  name: string
  /** Current connection lifecycle state. */
  state: McpConnectionState
  /** The last error message, when the state is `error`. */
  error?: string
  /** The number of tools this server currently exposes, when known. */
  toolCount?: number
  /** Whether interacting with this server requires OAuth authorization. */
  authRequired?: boolean
}

/** A parsed `/mcp` invocation. */
export type McpInput =
  | { kind: 'list' }
  | { kind: 'reconnect'; name: string }
  | { kind: 'disconnect'; name: string }
  | { kind: 'migrate' }
  | { kind: 'usage' }

/**
 * Parse the raw input after `/mcp`. Empty input lists; `reconnect <name>` and
 * `disconnect <name>` drive the named server; anything else is usage.
 * @param rawInput - `invocation.rawInput`, the text after the command name.
 */
export function parseMcpInput(rawInput: string): McpInput {
  const tokens = rawInput.trim().split(/\s+/u).filter(token => token.length > 0)
  if (tokens.length === 0) return { kind: 'list' }
  const [sub, name, ...rest] = tokens
  if (sub === 'reconnect') {
    if (name !== undefined && rest.length === 0) return { kind: 'reconnect', name }
    return { kind: 'usage' }
  }
  if (sub === 'disconnect') {
    if (name !== undefined && rest.length === 0) return { kind: 'disconnect', name }
    return { kind: 'usage' }
  }
  if (sub === 'migrate') {
    if (tokens.length === 1) return { kind: 'migrate' }
    return { kind: 'usage' }
  }
  return { kind: 'usage' }
}

/**
 * Render one connection line: `name (state)`, with tool count and auth markers
 * when known.
 */
export function formatConnectionLine(entry: McpConnectionEntry): string {
  const parts: string[] = [`${entry.name} (${entry.state})`]
  if (entry.toolCount !== undefined) parts.push(`tools: ${entry.toolCount}`)
  if (entry.authRequired !== undefined) parts.push(entry.authRequired ? 'auth required' : 'auth ok')
  if (entry.state === 'error' && entry.error !== undefined) parts.push(`error: ${entry.error}`)
  return parts.join(' ')
}

/** Render the connection index. */
export function formatConnections(entries: readonly McpConnectionEntry[]): string {
  if (entries.length === 0) return 'No MCP servers are registered.'
  const lines: string[] = ['MCP connections:']
  for (const entry of entries) lines.push(`- ${formatConnectionLine(entry)}`)
  return lines.join('\n')
}

/** Render the `/mcp` usage text. */
export function formatUsage(): string {
  return [
    'Usage:',
    '  /mcp                          list MCP connections',
    '  /mcp migrate                  import Claude Code MCP config into dsh',
    '  /mcp reconnect <name>         reconnect an MCP server',
    '  /mcp disconnect <name>        disconnect an MCP server',
  ].join('\n')
}

/**
 * Render the `/mcp migrate` result report. Pure: it only stringifies its
 * argument; all file I/O happened in the caller.
 * @param result - the {@link McpMigrationResult} produced by `migrateMcpServers`.
 */
export function formatMigrateReport(result: McpMigrationResult): string {
  if (result.wrote === false) {
    const lines: string[] = [`Nothing to migrate — ${result.target} is already up to date.`]
    for (const source of result.sources) {
      if (source.error !== undefined) lines.push(`${source.path}: unreadable — ${source.error}`)
    }
    return lines.join('\n')
  }
  const lines: string[] = []
  for (const source of result.sources) {
    if (source.error !== undefined) lines.push(`${source.path}: unreadable — ${source.error}`)
    else lines.push(`${source.path}: ${source.servers.length} servers`)
  }
  if (result.added.length > 0) lines.push(`added: ${result.added.join(', ')}`)
  if (result.kept.length > 0) {
    lines.push(`kept (already in dsh config): ${result.kept.join(', ')}`)
  }
  for (const conflict of result.sourceConflicts) {
    lines.push(`name taken from ${conflict.kept}, skipped ${conflict.skipped}: ${conflict.name}`)
  }
  if (result.backup !== undefined) lines.push(`backup: ${result.backup}`)
  lines.push(`target: ${result.target}`)
  lines.push(
    `The Claude Code source files were not modified — remove them manually when happy.`,
    `Servers load only after restarting the session.`,
  )
  return lines.join('\n')
}

/**
 * Render the discovery notice appended to `/mcp` list output when Claude Code
 * MCP servers are shadowed by the dsh-native config. Pure.
 * @param sources - the Claude Code sources holding servers not declared by any dsh file.
 * @param target - the migration target path to run `/mcp migrate` into.
 */
export function formatDiscoveryNotice(sources: readonly ClaudeOnlySource[], target: string): string {
  const counts = sources.map(source => `${source.path} (${source.names.length} servers)`)
  const lines = [
    `MCP: dsh config takes precedence — these Claude Code servers are not loaded: ${counts.join(', ')}.`,
    `Run /mcp migrate to import them into ${target}, then restart the session.`,
  ]
  return lines.join('\n')
}
