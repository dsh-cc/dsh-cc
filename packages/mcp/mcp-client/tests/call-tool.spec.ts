/**
 * Tests for the registry callTool passthrough and the connection control
 * surface (design doc docs/plans/2026-09-23-lsp-diagnostics-on-write.md §4.2):
 * `McpConnectionsService.callTool` delegates to the registered control, an
 * absent server or a control without `callTool` throws, and timeoutMs/signal
 * thread into the MCP SDK RequestOptions exactly as the executor path does.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import type { Config } from '@dsh-cc/mcp-client'
import { McpConnectionsService } from '@dsh-cc/mcp-client'

// ---- Mock MCP SDK (isolated to this file, as in registry.spec.ts) ----
const { mockConnect, mockClose, mockListTools, mockSetNotificationHandler, mockRequest, MockClient, instances, calls } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<() => Promise<unknown>>()
  const mockSetNotificationHandler = vi.fn()
  const calls: { request: Record<string, unknown>; options?: Record<string, unknown> }[] = []
  const mockRequest = vi.fn(async (request: { method: string }, _schema: unknown, options?: Record<string, unknown>): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools()
    if (request.method === 'tools/call') {
      calls.push({ request: request as unknown as Record<string, unknown>, options })
      return { content: [{ type: 'text', text: 'diag text' }] }
    }
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockClient {
    onclose: (() => void) | undefined
    connect = mockConnect
    close = mockClose
    request = mockRequest
    setNotificationHandler = mockSetNotificationHandler
    constructor() { instances.push(this) }
  }
  const instances: MockClient[] = []
  return { mockConnect, mockClose, mockListTools, mockSetNotificationHandler, mockRequest, MockClient, instances, calls }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: MockClient }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn() }))

import { apply } from '@dsh-cc/mcp-client/src/index.ts'

function listing(name: string): { tools: { name: string; inputSchema: { type: string } }[]; nextCursor: undefined } {
  return { tools: [{ name, inputSchema: { type: 'object' } }], nextCursor: undefined }
}

function stdioConfig(serverName: string): Config {
  return {
    transport: 'stdio',
    serverName,
    command: 'echo',
    args: [],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
  }
}

let ctx: Context

beforeEach(async () => {
  vi.clearAllMocks()
  calls.length = 0
  instances.length = 0
  mockConnect.mockResolvedValue(undefined)
  mockClose.mockImplementation(function (this: { onclose?: () => void }) {
    this.onclose?.()
    return Promise.resolve()
  })
  mockListTools.mockResolvedValue(listing('remote'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
})

describe('mcpConnections.callTool', () => {
  it('delegates to the live connection when the server is present', async () => {
    await apply(ctx, stdioConfig('srv1'))
    const result = await ctx.mcpConnections.callTool('srv1', 'get_diagnostics_for_file', { relative_path: 'a.ts' })
    expect(result).toEqual({ content: [{ type: 'text', text: 'diag text' }] })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.request).toMatchObject({
      method: 'tools/call',
      params: { name: 'get_diagnostics_for_file', arguments: { relative_path: 'a.ts' } },
    })
  })

  it('threads timeoutMs and signal into the SDK RequestOptions (defaults to toolCallTimeoutMs)', async () => {
    await apply(ctx, stdioConfig('srv1'))
    const signal = new AbortController().signal
    await ctx.mcpConnections.callTool('srv1', 't', {}, { timeoutMs: 1500, signal })
    expect(calls[0]!.options).toMatchObject({ timeout: 1500, signal })
    await ctx.mcpConnections.callTool('srv1', 't', {})
    expect(calls[1]!.options).toMatchObject({ timeout: 60_000 })
  })

  it('throws for an absent server', async () => {
    await apply(ctx, stdioConfig('srv1'))
    await expect(ctx.mcpConnections.callTool('nope', 't', {})).rejects.toThrow(/no server "nope"/)
  })

  it('throws when the registered control has no callTool', async () => {
    const service = new McpConnectionsService(ctx)
    service.register('legacy', { disconnect: async () => {}, reconnect: async () => {} })
    await expect(service.callTool('legacy', 't', {})).rejects.toThrow(/does not expose a callTool control/)
  })

  it('throws when the connection is not established (disconnected)', async () => {
    await apply(ctx, stdioConfig('srv1'))
    await ctx.mcpConnections.disconnect('srv1')
    await expect(ctx.mcpConnections.callTool('srv1', 't', {})).rejects.toThrow(/callTool unavailable/)
  })

  it('MCP isError: true surfaces as a throw', async () => {
    await apply(ctx, stdioConfig('srv1'))
    mockRequest.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'boom' }] })
    await expect(ctx.mcpConnections.callTool('srv1', 't', {})).rejects.toThrow('boom')
  })
})
