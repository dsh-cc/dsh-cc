/**
 * Human-facing `/mcp` command: list the registered MCP servers, import the
 * Claude Code MCP config into `$DSH_HOME/.mcp.json`, or reconnect/disconnect
 * one by name. It reads and drives the optional `mcpConnections` service
 * mounted by mcp-client; when that service is absent it reports the seam
 * gracefully rather than failing, but `migrate` works regardless because it
 * is pure file I/O against the shared config paths.
 * @module @dsh-cc/command-mcp
 */

import { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import {
  claudeOnlyServers,
  migrateMcpServers,
  readMcpServerNames,
  resolveDefaultMcpPaths,
} from '@dsh-cc/mcp-config'
import {
  formatConnections,
  formatDiscoveryNotice,
  formatMigrateReport,
  formatUsage,
  parseMcpInput,
  type McpConnectionEntry,
} from './mcp.ts'

export const name = 'command-mcp'
export const inject = ['commands']

/**
 * The minimal structural face of the optional `mcpConnections` service that an
 * mcp-client instance provides. Kept local and structural so this package need
 * not depend on the mcp-client package's full dependency graph.
 */
export interface McpConnectionsSeam {
  /** A snapshot of every registered server today. */
  entries(): McpConnectionEntry[]
  /** Disconnect a registered server by name. */
  disconnect(name: string): Promise<void>
  /** Reconnect a registered server by name. */
  reconnect(name: string): Promise<void>
}

/** Resolve the optional mcpConnections seam, or undefined when not composed. */
function seam(ctx: Context): McpConnectionsSeam | undefined {
  return ctx.get('mcpConnections') as McpConnectionsSeam | undefined
}

/** Run the `/mcp migrate` import against the shared default config paths. */
function migrate(): CommandResult {
  const paths = resolveDefaultMcpPaths()
  try {
    const result = migrateMcpServers({ sources: paths.claude, target: paths.target })
    return { kind: 'success', text: formatMigrateReport(result) }
  } catch (error) {
    return { kind: 'success', text: `Failed to migrate: ${String(error)}` }
  }
}

/** Execute `/mcp [sub]` against the optional mcpConnections seam. */
async function executeMcp(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const input = parseMcpInput(invocation.rawInput)
  if (input.kind === 'migrate') return migrate()
  const connections = seam(ctx)
  if (connections === undefined) {
    return { kind: 'success', text: 'No MCP connection registry is mounted in this composition (mcp-client absent).' }
  }
  switch (input.kind) {
    case 'list': {
      let text = formatConnections(connections.entries())
      const paths = resolveDefaultMcpPaths()
      // The notice mirrors the loader's gate: only when a dsh-native config
      // declares at least one server are Claude Code files actually skipped —
      // otherwise they are loaded and there is nothing to nag about.
      const gated = paths.dsh.some((file) => {
        const read = readMcpServerNames(file)
        return read.kind === 'ok' && read.names.length > 0
      })
      if (gated) {
        const sources = claudeOnlyServers(paths)
        if (sources.length > 0) text += `\n\n${formatDiscoveryNotice(sources, paths.target)}`
      }
      return { kind: 'success', text }
    }
    case 'reconnect': {
      try {
        await connections.reconnect(input.name)
        return { kind: 'success', text: `Reconnecting MCP server "${input.name}".` }
      } catch (error) {
        return { kind: 'success', text: `Failed to reconnect MCP server "${input.name}": ${String(error)}` }
      }
    }
    case 'disconnect': {
      try {
        await connections.disconnect(input.name)
        return { kind: 'success', text: `Disconnected MCP server "${input.name}".` }
      } catch (error) {
        return { kind: 'success', text: `Failed to disconnect MCP server "${input.name}": ${String(error)}` }
      }
    }
    case 'usage':
      return { kind: 'success', text: formatUsage() }
  }
}

/**
 * Register the `/mcp` command for every composed command adapter.
 * @param ctx - context carrying the command registry.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'mcp',
    description: 'list MCP connections, import Claude Code config, or reconnect/disconnect one by name',
    input: { hint: '[migrate|reconnect|disconnect <name>]' },
    handler: (invocation: CommandInvocation) => executeMcp(ctx, invocation),
  })
}
