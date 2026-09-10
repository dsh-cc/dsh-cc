/**
 * Tests for the mcp-client MCP connection registry (`mcpConnections` service):
 * every instance registers and appears in `entries()`, state transitions
 * connecting→ready, `disconnect(name)` marks an entry disconnected (and
 * unregisters its tools), and `reconnect(name)` re-establishes a fresh
 * connection. The MCP SDK is mocked as in reconnect.spec.ts; two instances are
 * driven through the real `apply` on a shared Context.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import type { Config } from '@dsh-cc/mcp-client'
import { McpConnectionsService } from '@dsh-cc/mcp-client'

// ---- Mock MCP SDK (isolated to this file, as in reconnect.spec.ts) ----
const { mockConnect, mockClose, mockListTools, mockSetNotificationHandler, MockClient, instances } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_p?: Record<string, unknown>) => Promise<unknown>>()
  const mockSetNotificationHandler = vi.fn()
  const mockRequest = vi.fn(async (request: { method: string }): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools()
    if (request.method === 'tools/call') return { content: [{ type: 'text', text: 'ok' }] }
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
  return { mockConnect, mockClose, mockListTools, mockSetNotificationHandler, MockClient, instances }
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

describe('McpConnectionsService / mcpConnections registry', () => {
  it('provides the service and two instances both appear ready in entries()', async () => {
    expect(ctx.get('mcpConnections')).toBeUndefined()

    await apply(ctx, stdioConfig('srv1'))
    await apply(ctx, stdioConfig('srv2'))

    const service = ctx.mcpConnections
    expect(service).toBeInstanceOf(McpConnectionsService)
    const entries = service.entries().map(entry => ({ name: entry.name, state: entry.state, toolCount: entry.toolCount, eagerCount: entry.eagerCount, deferredCount: entry.deferredCount }))
    expect(entries).toHaveLength(2)
    expect(entries).toContainEqual({ name: 'srv1', state: 'ready', toolCount: 1, eagerCount: 1, deferredCount: 0 })
    expect(entries).toContainEqual({ name: 'srv2', state: 'ready', toolCount: 1, eagerCount: 1, deferredCount: 0 })
  })

  it('records state transitions connecting → ready for an instance', async () => {
    // Gate the initial connection so we can observe the interim state.
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(() => gate.promise)
    const applying = apply(ctx, stdioConfig('srv1'))
    await vi.waitFor(() => { expect(ctx.get('mcpConnections')).toBeDefined() })
    expect(ctx.mcpConnections.entries()[0]!.state).toBe('connecting')

    gate.resolve()
    await applying
    expect(ctx.mcpConnections.entries()[0]!.state).toBe('ready')
  })

  it('disconnect(name) marks the entry disconnected and unregisters its tools', async () => {
    await apply(ctx, stdioConfig('srv1'))
    expect(ctx.tools.get('mcp__srv1__remote')).toBeDefined()

    await ctx.mcpConnections.disconnect('srv1')

    const entry = ctx.mcpConnections.entries().find(e => e.name === 'srv1')!
    expect(entry.state).toBe('disconnected')
    expect(ctx.tools.get('mcp__srv1__remote')).toBeUndefined()
  })

  it('reconnect(name) tears down and re-establishes a fresh connection', async () => {
    await apply(ctx, stdioConfig('srv1'))
    expect(instances).toHaveLength(1)
    const firstClient = instances[0]!

    await ctx.mcpConnections.reconnect('srv1')

    expect(instances.length).toBeGreaterThanOrEqual(2)
    expect(instances[0]).toBe(firstClient) // old client retained in the list
    const entry = ctx.mcpConnections.entries().find(e => e.name === 'srv1')!
    expect(entry.state).toBe('ready')
    expect(entry.toolCount).toBe(1)
    // The fresh generation re-exposed the tool.
    expect(ctx.tools.get('mcp__srv1__remote')).toBeDefined()
  })

  it('setToolBreakdown records eager/deferred counts and the invariant eager + deferred = toolCount', () => {
    const service = new McpConnectionsService(ctx)
    service.register('brk', { disconnect: async () => {}, reconnect: async () => {} })

    service.setToolBreakdown('brk', { eager: 3, deferred: 2 })

    const entry = service.entries().find(e => e.name === 'brk')!
    expect(entry.eagerCount).toBe(3)
    expect(entry.deferredCount).toBe(2)
    expect(entry.toolCount).toBe(5)
    expect(entry.eagerCount! + entry.deferredCount!).toBe(entry.toolCount)
  })

  it('setToolCount sets only toolCount, leaving breakdown fields undefined', () => {
    const service = new McpConnectionsService(ctx)
    service.register('tot', { disconnect: async () => {}, reconnect: async () => {} })

    service.setToolCount('tot', 4)

    const entry = service.entries().find(e => e.name === 'tot')!
    expect(entry.toolCount).toBe(4)
    expect(entry.eagerCount).toBeUndefined()
    expect(entry.deferredCount).toBeUndefined()
  })

  it('throws for an unregistered server on disconnect/reconnect', async () => {
    await apply(ctx, stdioConfig('srv1'))
    await expect(ctx.mcpConnections.disconnect('nope')).rejects.toThrow(/no server "nope"/)
    await expect(ctx.mcpConnections.reconnect('nope')).rejects.toThrow(/no server "nope"/)
  })

  it('unregisters the entry on plugin teardown', async () => {
    const fiber = await ctx.plugin(
      { name: 'mcp-client', inject: ['tools'], apply },
      stdioConfig('srv1'),
    )
    expect(ctx.mcpConnections.entries()).toHaveLength(1)

    await fiber.dispose()
    // The registry service is effect-scoped to the fiber that provided it, so
    // teardown removes the service (and its entries) entirely.
    expect(ctx.get('mcpConnections')).toBeUndefined()
  })

  it('onDidChange fires a snapshot copy on register, report, and unregister', () => {
    const service = new McpConnectionsService(ctx)
    const control = { disconnect: async () => {}, reconnect: async () => {} }
    const events: { name: string; state: string; error?: string }[] = []
    service.onDidChange(entry => events.push({ name: entry.name, state: entry.state, error: entry.error }))

    service.register('ev', control)
    expect(events).toEqual([{ name: 'ev', state: 'connecting' }])

    service.report('ev', 'error', { error: 'boom happened' })
    expect(events[1]).toMatchObject({ name: 'ev', state: 'error', error: 'boom happened' })

    service.unregister('ev')
    expect(events[2]).toMatchObject({ name: 'ev', state: 'error', error: 'boom happened' })
  })

  it('onDidChange delivers a COPY: mutating the delivered entry does not affect entries()', () => {
    const service = new McpConnectionsService(ctx)
    service.register('cpy', { disconnect: async () => {}, reconnect: async () => {} })
    service.onDidChange(entry => {
      entry.state = 'ready'
      entry.toolCount = 99
    })
    service.report('cpy', 'connecting')
    const entry = service.entries().find(e => e.name === 'cpy')!
    expect(entry.state).toBe('connecting')
    expect(entry.toolCount).toBeUndefined()
  })

  it('the returned disposer stops onDidChange delivery', () => {
    const service = new McpConnectionsService(ctx)
    service.register('dsp', { disconnect: async () => {}, reconnect: async () => {} })
    const events: string[] = []
    const dispose = service.onDidChange(entry => events.push(entry.state))
    dispose()
    service.report('dsp', 'ready')
    expect(events).toEqual([])
  })

  it('a throwing onDidChange listener is contained: others still fire, report does not throw', () => {
    const service = new McpConnectionsService(ctx)
    const warnings: string[] = []
    ctx.logger.warn = (message: unknown, ...rest: unknown[]) => { warnings.push(`${String(message)}${rest.join('')}`) }
    service.register('thr', { disconnect: async () => {}, reconnect: async () => {} })
    service.onDidChange(() => { throw new Error('listener exploded') })
    const seen: string[] = []
    service.onDidChange(entry => seen.push(entry.state))

    expect(() => service.report('thr', 'ready')).not.toThrow()
    expect(seen).toEqual(['ready'])
    expect(warnings.some(w => w.includes('listener'))).toBe(true)
  })

  it('a registry provided by a parent plugin survives an instance rollback', async () => {
    // Mirror the glue topology: parent mounts a registry child fiber first, then a
    // failing instance (failOnStartupError), then a healthy one.
    const parent = {
      name: 'parent',
      inject: ['tools'],
      async apply(pctx: Context) {
        await pctx.plugin({ name: 'registry', apply(c: Context) { new McpConnectionsService(c) } })
        mockConnect.mockRejectedValueOnce(new Error('boom'))
        await expect(
          pctx.plugin({ name: 'mcp-client', inject: ['tools'], apply }, { ...stdioConfig('bad'), failOnStartupError: true }),
        ).rejects.toThrow(/initial connection or tool synchronization failed/)
        await pctx.plugin({ name: 'mcp-client', inject: ['tools'], apply }, stdioConfig('good'))
      },
    }
    await ctx.plugin(parent)
    const registry = ctx.get('mcpConnections')
    expect(registry).toBeDefined()
    const names = registry!.entries().map(e => `${e.name}:${e.state}`)
    expect(names).toContain('good:ready')
    expect(names).not.toContain('bad:connecting')
  })
})
