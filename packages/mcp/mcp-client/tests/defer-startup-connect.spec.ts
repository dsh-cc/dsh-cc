/**
 * Tests for the optional `deferStartupConnect` config field: when true, the
 * plugin's `apply` returns right after the namespace reservation and registry
 * registration — the initial connect runs un-awaited and its settle
 * continuation updates the registry and tools. Covers the deferred happy
 * path, the agent-mount wiring, the contained failure path (reconnect off),
 * and disposal racing an in-flight deferred connect.
 *
 * Isolated file so vi.mock of the MCP SDK doesn't pollute other test suites.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import type { Config } from '@dsh-cc/mcp-client'

// ---- Mock MCP SDK ----

// vi.mock factories are hoisted above every import/const, so the mock fns and
// class must be created inside vi.hoisted to exist when the factories run.
const { mockConnect, mockClose, mockListTools, mockCallTool, mockSetNotificationHandler, MockClient } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockCallTool = vi.fn<(
    _params?: Record<string, unknown>, _compatibilitySchema?: unknown, _options?: unknown,
  ) => Promise<unknown>>()
  const mockSetNotificationHandler = vi.fn()
  const mockRequest = vi.fn(async (
    request: { method: string; params?: Record<string, unknown> },
    _schema: unknown,
    options?: unknown,
  ): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools(request.params)
    if (request.method === 'tools/call') return await mockCallTool(request.params, undefined, options)
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockClient {
    connect = mockConnect
    close = mockClose
    listTools = mockListTools
    callTool = mockCallTool
    request = mockRequest
    setNotificationHandler = mockSetNotificationHandler
  }
  return { mockConnect, mockClose, mockListTools, mockCallTool, mockSetNotificationHandler, MockClient }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(),
}))

// vi.mock is hoisted above static imports, so the modules under test see the
// mocked SDK even through a static import.
import { apply, Config as ConfigSchema } from '@dsh-cc/mcp-client/src/index.ts'
import type { McpConnectionsService } from '@dsh-cc/mcp-client/src/registry.ts'

// ---- Helpers ----

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

const testToolSignal = new AbortController().signal

function deferredStdioConfig(overrides: Partial<Config> = {}): Config {
  return {
    transport: 'stdio',
    serverName: 'srv',
    command: 'echo',
    args: [],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    deferStartupConnect: true,
    ...overrides,
  }
}

function registryOf(ctx: Context): McpConnectionsService {
  return ctx.get('mcpConnections') as McpConnectionsService
}

/** Capture the instance's logger lines by level. */
function captureLogs(ctx: Context): { warns: string[] } {
  const warns: string[] = []
  ctx.logger.warn = ((message: unknown) => { warns.push(String(message)) }) as typeof ctx.logger.warn
  return { warns }
}

// ---- Tests ----

describe('deferStartupConnect schema', () => {
  it('defaults to false and accepts an explicit true', () => {
    const omitted = ConfigSchema({ transport: 'stdio', serverName: 'srv', command: 'echo' } as never)
    expect(omitted.deferStartupConnect).toBe(false)
    const explicit = ConfigSchema({ transport: 'stdio', serverName: 'srv', command: 'echo', deferStartupConnect: true } as never)
    expect(explicit.deferStartupConnect).toBe(true)
  })
})

describe('deferStartupConnect: true', () => {
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue({
      tools: [{ name: 'remote', description: 'A remote tool', inputSchema: { type: 'object' } }],
      nextCursor: undefined,
    })
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    ctx = await mountRegistry()
  })

  it('apply resolves while a slow handshake is still pending; state connecting, no tools yet', async () => {
    const handshake: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(() => handshake.promise)
    const { warns } = captureLogs(ctx)

    await apply(ctx, deferredStdioConfig())

    expect(registryOf(ctx).entries().find(e => e.name === 'srv')).toMatchObject({ name: 'srv', state: 'connecting' })
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    // No failure noise for a merely-slow server.
    expect(warns.some(line => line.includes('srv'))).toBe(false)

    handshake.resolve()
    await vi.waitFor(() => {
      expect(registryOf(ctx).entries().find(e => e.name === 'srv')).toMatchObject({ state: 'ready' })
    })
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
  })

  it('after ready, tools are visible and callable through ctx.tools', async () => {
    const handshake: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(() => handshake.promise)

    await apply(ctx, deferredStdioConfig())
    handshake.resolve()
    await vi.waitFor(() => {
      expect(registryOf(ctx).entries().find(e => e.name === 'srv')).toMatchObject({ state: 'ready', toolCount: 1 })
    })

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: 'defer-call-1' as never,
      name: 'mcp__srv__remote',
      arguments: {},
    })
    expect(result.isError).toBe(false)
  })

  it('agent-mount wiring: the fiber activates before the handshake and tools register post-activation', async () => {
    const handshake: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(() => handshake.promise)

    // The same wiring shape the preset uses: the plugin mounts under a fiber
    // with the `tools` inject, inside a registry-providing scope.
    const fiber = ctx.plugin({ name: 'mcp-client', inject: ['tools'], apply }, deferredStdioConfig())
    await fiber
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()

    handshake.resolve()
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    expect(registryOf(ctx).entries().find(e => e.name === 'srv')).toMatchObject({ state: 'ready' })
    await fiber.dispose()
  })

  it('a failing server with reconnect disabled: apply resolves, error reported, warn logged, nothing thrown', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => { unhandled.push(error) }
    process.on('unhandledRejection', onUnhandled)
    try {
      mockConnect.mockRejectedValue(new Error('connection refused'))
      const { warns } = captureLogs(ctx)

      await expect(apply(ctx, deferredStdioConfig({ reconnect: { enabled: false } }))).resolves.toBeUndefined()

      await vi.waitFor(() => {
        expect(registryOf(ctx).entries().find(e => e.name === 'srv')).toMatchObject({ state: 'error' })
      })
      expect(warns.some(line => line.includes('connection attempt failed') || line.includes('connection refused'))).toBe(true)
      expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('dispose during connecting: no late registry writes when the handshake settles afterwards', async () => {
    const handshake: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(() => handshake.promise)
    const { warns } = captureLogs(ctx)

    const fiber = ctx.plugin({ name: 'mcp-client', inject: ['tools'], apply }, deferredStdioConfig())
    await fiber
    expect(registryOf(ctx).entries().find(e => e.name === 'srv')).toMatchObject({ state: 'connecting' })

    // Standalone instance: the lazy registry dies with the fiber — capture
    // the service reference before disposal to observe the unregistration.
    const registry = registryOf(ctx)
    // Disposal quiesces the in-flight attempt: resolve the handshake while
    // teardown is waiting, so the late settle races the unregister.
    const disposing = fiber.dispose()
    handshake.resolve()
    await disposing

    expect(registry.entries().some(e => e.name === 'srv')).toBe(false)
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    expect(warns.some(line => line.includes('ready') || line.includes('tool count'))).toBe(false)
  })
})

describe('deferStartupConnect: false (default) is unchanged', () => {
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue({
      tools: [{ name: 'remote', description: 'A remote tool', inputSchema: { type: 'object' } }],
      nextCursor: undefined,
    })
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    ctx = await mountRegistry()
  })

  it('apply stays blocking on the handshake (activation completes only after ready)', async () => {
    const handshake: PromiseWithResolvers<void> = Promise.withResolvers()
    mockConnect.mockImplementation(() => handshake.promise)

    const applying = apply(ctx, { ...deferredStdioConfig(), deferStartupConnect: undefined })
    let settled = false
    void applying.then(() => { settled = true })

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    expect(mockConnect).toHaveBeenCalled()

    handshake.resolve()
    await applying
    expect(registryOf(ctx).entries().find(e => e.name === 'srv')).toMatchObject({ state: 'ready' })
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('failOnStartupError=true rejects activation and forces blocking even with defer requested', async () => {
    mockConnect.mockRejectedValue(new Error('connection refused'))
    await expect(apply(ctx, deferredStdioConfig({ failOnStartupError: true })))
      .rejects.toThrow('initial connection or tool synchronization failed')
    await ctx.fiber.dispose()
  })
})
