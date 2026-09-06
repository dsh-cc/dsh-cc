/**
 * `mcp` checks for `/doctor`: per-connection status rows and the Serena
 * cross-check, duck-typing the `mcpConnections` seam.
 * @module @dsh-cc/command-doctor/checks/mcp
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Check } from '../report.ts'
import type { GitInfo } from './git.ts'

/** Duck-typed `mcpConnections` entry face used here. */
export interface McpEntry {
  readonly name: string
  readonly state: string
  readonly error?: string
  readonly toolCount?: number
  readonly eagerCount?: number
  readonly deferredCount?: number
  readonly authRequired?: boolean
}

/** Collect the mcp group checks. */
export function mcpChecks(ctx: Context, options: { git?: GitInfo; verbose?: boolean } = {}): Check[] {
  const connections = ctx.get('mcpConnections') as
    | { entries(): McpEntry[] }
    | undefined
  if (connections?.entries === undefined) {
    return [{
      id: 'mcp.registry',
      group: 'mcp',
      status: 'skip',
      summary: 'mcpConnections not mounted',
    }]
  }
  const entries = connections.entries()
  const checks: Check[] = [{
    id: 'mcp.overview',
    group: 'mcp',
    status: 'ok',
    summary: `${entries.length} servers`,
    evidence: { count: entries.length },
  }]
  for (const entry of entries) checks.push(entryCheck(entry))
  checks.push(serenaCheck(entries, options))
  return checks
}

/** Map one connection entry to its check row. */
function entryCheck(entry: McpEntry): Check {
  const id = `mcp.server.${entry.name}`
  if (entry.authRequired === true) {
    return warn(id, `${entry.name}: authentication required`)
  }
  if (entry.state === 'ready') {
    if ((entry.toolCount ?? 0) > 0) {
      return {
        id,
        group: 'mcp',
        status: 'ok',
        summary: `${entry.name}: ready with ${entry.toolCount} tools`,
        detail: toolBreakdown(entry),
        evidence: { state: entry.state, toolCount: entry.toolCount ?? 0 },
      }
    }
    return warn(id, `${entry.name}: ready with 0 tools`)
  }
  if (entry.state === 'connecting') {
    return {
      id,
      group: 'mcp',
      status: 'info',
      summary: `${entry.name}: connecting`,
      evidence: { state: entry.state },
    }
  }
  return {
    id,
    group: 'mcp',
    status: 'fail',
    summary: `${entry.name}: ${entry.state}`,
    detail: entry.error,
    fix: 'check the server command/logs or run /mcp reconnect',
    evidence: { state: entry.state },
  }
}

/** Render eager/deferred breakdown when the entry exposes it. */
function toolBreakdown(entry: McpEntry): string | undefined {
  if (entry.eagerCount === undefined && entry.deferredCount === undefined) return undefined
  return `eager ${entry.eagerCount ?? 0}, deferred ${entry.deferredCount ?? 0}`
}

function warn(id: string, summary: string): Check {
  return { id, group: 'mcp', status: 'warn', summary }
}

/** The Serena-specific row: present and not ready is a fail. */
function serenaCheck(entries: readonly McpEntry[], options: { git?: GitInfo; verbose?: boolean }): Check {
  const serena = entries.find(entry => /serena/i.test(entry.name))
  if (serena === undefined) {
    return { id: 'mcp.serena', group: 'mcp', status: 'skip', summary: 'no serena server' }
  }
  const base: Check = serena.state === 'ready'
    ? {
        id: 'mcp.serena',
        group: 'mcp',
        status: 'ok',
        summary: `${serena.name}: ready`,
        evidence: { state: serena.state },
      }
    : {
        id: 'mcp.serena',
        group: 'mcp',
        status: 'fail',
        summary: `${serena.name}: ${serena.state}`,
        detail: serena.error,
        fix: 'run /mcp reconnect or start the Serena server',
        evidence: { state: serena.state },
      }
  const crossNote = options.git?.worktree === true && options.git.hasSerena === false
    ? 'this cwd looks like a git worktree without a .serena directory; Serena project memory may resolve against the main checkout'
    : undefined
  if (crossNote === undefined) return base
  return { ...base, detail: [base.detail, crossNote].filter(part => part !== undefined).join(' — ') }
}
