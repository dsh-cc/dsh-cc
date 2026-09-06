/**
 * Connection-level capability integration: when a server declares tools,
 * resources, and prompts capabilities, the supervisor registers tools, the
 * resource bridge, and prompt-skills; and disposal (an effect-scoped unmount)
 * unregisters them — firing `tools/change` both ways. Isolated SDK mock so it
 * does not pollute other suites.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'

const { mockConnect, mockClose, MockClient, mockGetCapabilities, instances } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockGetCapabilities = vi.fn<() => unknown>()
  const mockRequest = vi.fn(async (request: { method: string; params?: Record<string, unknown> }): Promise<unknown> => {
    switch (request.method) {
      case 'tools/list':
        return { tools: [{ name: 'greet', inputSchema: { type: 'object' } }], nextCursor: undefined }
      case 'resources/list':
        return { resources: [{ uri: 'file:///a', name: 'a' }], nextCursor: undefined }
      case 'prompts/list':
        return { prompts: [{ name: 'hint', description: 'A hint' }], nextCursor: undefined }
      case 'prompts/get':
        return { messages: [{ role: 'user', content: { type: 'text', text: 'Follow the instructions.' } }] }
      default:
        throw new Error(`unexpected request: ${request.method}`)
    }
  })
  class MockClient {
    onclose: (() => void) | undefined
    connect = mockConnect
    close = mockClose
    request = mockRequest
    getServerCapabilities = mockGetCapabilities
    setNotificationHandler = vi.fn()
    constructor() { instances.push(this) }
  }
  const instances: MockClient[] = []
  return { mockConnect, mockClose, MockClient, mockGetCapabilities, instances }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: MockClient }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: vi.fn() }))

import { startConnection, resolveReconnectPolicy } from '@dsh-cc/mcp-client/src/connection.ts'
import type { Config } from '@dsh-cc/mcp-client'

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  return ctx
}

function stdioConfig(overrides: Partial<Config> = {}): Config {
  const base: Config = {
    transport: 'stdio',
    serverName: 'srv',
    command: 'node',
    args: [],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: true,
  }
  return { ...base, ...overrides } as Config
}

beforeEach(() => {
  instances.length = 0
  vi.clearAllMocks()
  mockConnect.mockResolvedValue(undefined)
  // A failing connect/close still closes the generation promptly: firing onclose
  // resolves the supervisor's close barrier so waitForClose returns immediately.
  mockClose.mockImplementation(function (this: { onclose?: () => void }) {
    this.onclose?.()
    return Promise.resolve()
  })
})

describe('capability branching on connect', () => {
  it('registers tools, resource bridge, and prompt skills, then unregisters on dispose via tools/change', async () => {
    mockGetCapabilities.mockReturnValue({
      tools: { listChanged: true },
      resources: { listChanged: true },
      prompts: { listChanged: true },
    })
    const ctx = await mountRegistry()
    let changeCount = 0
    ctx.on('tools/change', () => { changeCount += 1 })

    const handle = startConnection(ctx, stdioConfig(), resolveReconnectPolicy(undefined, 'test'))
    const outcome = await handle.ready
    expect(outcome.error).toBeUndefined()

    // Tool, list-resource, and read-resource are tool registrations (each emits tools/change).
    expect(ctx.tools.get('mcp__srv__greet')).toBeDefined()
    expect(ctx.tools.get('mcp__srv__list_mcp_resources')).toBeDefined()
    expect(ctx.tools.get('mcp__srv__read_mcp_resource')).toBeDefined()
    // Prompt skill registered through the skill registry.
    const skill = await ctx.skills.get('mcp-srv-hint', {})
    expect(skill?.content).toContain('Follow the instructions.')
    expect(changeCount).toBeGreaterThanOrEqual(3)

    // Effect-scoped unmount on dispose unregisters every registration (more tools/change).
    await handle.dispose()
    expect(ctx.tools.get('mcp__srv__greet')).toBeUndefined()
    expect(ctx.tools.get('mcp__srv__list_mcp_resources')).toBeUndefined()
    expect(ctx.tools.get('mcp__srv__read_mcp_resource')).toBeUndefined()
    expect(await ctx.skills.get('mcp-srv-hint', {})).toBeUndefined()
    expect(changeCount).toBeGreaterThanOrEqual(6)
  })

  it('syncs nothing extra beyond tools when only tools are declared', async () => {
    mockGetCapabilities.mockReturnValue({ tools: {} })
    const ctx = await mountRegistry()
    const handle = startConnection(ctx, stdioConfig(), resolveReconnectPolicy(undefined, 'test'))
    await handle.ready

    expect(ctx.tools.get('mcp__srv__greet')).toBeDefined()
    expect(ctx.tools.get('mcp__srv__list_mcp_resources')).toBeUndefined()
    expect(await ctx.skills.get('mcp-srv-hint', {})).toBeUndefined()
    await handle.dispose()
  })

  it('always bridges tools but skips resource/prompt bridges when capabilities are absent', async () => {
    mockGetCapabilities.mockReturnValue({})
    const ctx = await mountRegistry()
    const handle = startConnection(ctx, stdioConfig({ failOnStartupError: false }), resolveReconnectPolicy(undefined, 'test'))
    await handle.ready

    // Tools are bridged unconditionally (long-standing behavior); only the
    // optional resource and prompt bridges are capability-gated.
    expect(ctx.tools.get('mcp__srv__greet')).toBeDefined()
    expect(ctx.tools.get('mcp__srv__list_mcp_resources')).toBeUndefined()
    expect(ctx.tools.get('mcp__srv__read_mcp_resource')).toBeUndefined()
    expect(await ctx.skills.get('mcp-srv-hint', {})).toBeUndefined()
    await handle.dispose()
  })
})
