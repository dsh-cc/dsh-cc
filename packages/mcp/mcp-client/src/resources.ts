/**
 * Resource bridge: exposes an MCP server's `resources` capability to the model
 * as two model tools when the server declares the capability and every other
 * pathway is unavailable.
 *
 * The preferred seam for read-only resources is a filesystem Provider, but the
 * `ctx.fs` seam abstracts *real* filesystems over `FsTarget` / `processPath` /
 * `readBytes` — it cannot represent virtual MCP resources (arbitrary URIs with
 * server-owned contents). So this module registers the next best fallback: two
 * server-qualified model tools, `mcp__<server>__list_mcp_resources` and
 * `mcp__<server>__read_mcp_resource`, that call `resources/list` and
 * `resources/read`. They share the tool-generation disposer map so disconnect
 * and re-sync unregister them together.
 *
 * @module
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  ListResourcesResultSchema,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolExecution } from '@dsh-cc/tools'
import type { JsonValue } from '@dsh-cc/tools'

/** Registered disposers for the two resource bridges; shared shape with tools. */
export type ResourceDisposers = Map<string, () => void>

/** List a page without the SDK's per-page output-validator cache. */
function listResourcesUncached(client: Client, cursor?: string) {
  return client.request(
    { method: 'resources/list', ...cursor === undefined ? {} : { params: { cursor } } },
    ListResourcesResultSchema,
  )
}

/** Read one resource without the SDK's per-page output-validator cache. */
function readResourceUncached(client: Client, uri: string, signal?: AbortSignal) {
  return client.request(
    { method: 'resources/read', params: { uri } },
    ReadResourceResultSchema,
    signal === undefined ? {} : { signal },
  )
}

/**
 * Register the two resource bridge tools on `ctx.tools` if they are not already
 * present. Registration conflicts (a server tool already owning the public
 * name) are contained and logged; the bridge should never shadow another tool.
 *
 * @param client - connected MCP client.
 * @param ctx - Cordis context providing the `tools` registry.
 * @param serverName - server namespace for the public tool names.
 * @returns the registered disposers (empty when the bridge could not register).
 */
export function syncResources(
  client: Client,
  ctx: Context,
  serverName: string,
): ResourceDisposers {
  const listPublicName = resourcePublicName(serverName, 'list_mcp_resources')
  const readPublicName = resourcePublicName(serverName, 'read_mcp_resource')
  const disposers: ResourceDisposers = new Map()
  const registrations: Array<{ publicName: string; definition: ToolDefinition }> = [
    { publicName: listPublicName, definition: listDefinition(listPublicName, client, serverName) },
    { publicName: readPublicName, definition: readDefinition(readPublicName, client) },
  ]
  for (const { publicName, definition } of registrations) {
    try {
      disposers.set(publicName, ctx.tools.register(definition))
    } catch (error) {
      ctx.logger.warn(`mcp-client(${serverName}): resource bridge "${publicName}" could not register: ${String(error)}`)
    }
  }
  return disposers
}

/**
 * Public name for one resource bridge tool under a server's namespace.
 * @param serverName - server namespace.
 * @param kind - `list_mcp_resources` or `read_mcp_resource`.
 * @returns the model-facing tool name `mcp__<serverName>__<kind>`.
 */
export function resourcePublicName(serverName: string, kind: string): string {
  return `mcp__${serverName}__${kind}`
}

/** ToolDefinition for `resources_list`: enumerate the server's resources. */
function listDefinition(publicName: string, client: Client, serverName: string): ToolDefinition {
  return {
    name: publicName,
    description: `List the resources exposed by the MCP server "${serverName}".`,
    parameters: {
      type: 'object',
      properties: {},
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: async (): Promise<string> => {
      const parts: Array<{ name?: string; uri: string; description?: string }> = []
      let cursor: string | undefined
      do {
        const page = await listResourcesUncached(client, cursor)
        for (const r of page.resources) {
          parts.push({
            uri: r.uri,
            name: r.name,
            ...r.description !== undefined ? { description: r.description } : {},
          })
        }
        cursor = page.nextCursor
      } while (cursor)
      if (parts.length === 0) return '(no resources)'
      return parts.map(r => `${r.uri}${r.name !== undefined ? ' — ' + r.name : ''}`).join('\n')
    },
  }
}

/** ToolDefinition for `resources_read`: read one resource by URI. */
function readDefinition(publicName: string, client: Client): ToolDefinition {
  return {
    name: publicName,
    description: 'Read the contents of one MCP resource by its URI.',
    parameters: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: 'The resource URI to read.' },
      },
      required: ['uri'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: async (args: unknown, exec: ToolExecution): Promise<string> => {
      const params = (typeof args === 'object' && args !== null ? args : {}) as { uri?: unknown }
      const uri = typeof params.uri === 'string' ? params.uri : ''
      if (uri === '') throw new Error('read_mcp_resource requires a "uri" argument')
      const result = await readResourceUncached(client, uri, exec.signal)
      const contents: string[] = []
      for (const block of result.contents) {
        // A resource content block is either text-shaped or blob-shaped.
        const item = block as unknown as { text?: string; blob?: string; uri?: string }
        if (item.text !== undefined) {
          contents.push(item.text)
        } else if (item.blob !== undefined) {
          contents.push(`[binary blob resource: ${item.uri ?? 'unknown'}]`)
        } else {
          contents.push('[unsupported resource content]')
        }
      }
      return contents.join('\n') || '(resource returned no contents)'
    },
  }
}

/** Re-exported canonically for callers that want the URL type. */
export type { JsonValue }
