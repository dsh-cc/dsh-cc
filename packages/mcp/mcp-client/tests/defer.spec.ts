/**
 * Deferred MCP tool disclosure through `ctx.toolSearch`.
 *
 * Phase 2 of docs/plans/2026-09-02-mcp-deferred-disclosure.md: over-threshold
 * servers register listed tools deferred (searchable, invisible until activated)
 * instead of eager. Per-tool `_meta['anthropic/alwaysLoad']` stays eager.
 * No `toolSearch` service ⇒ eager fallback.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type JsonValue } from '@dsh-cc/tools'
import DeferredToolRegistry from '@dsh-cc/tool-search'
import { emptyToolGeneration, syncTools, type ToolBridgeOptions } from '@dsh-cc/mcp-client/src/tools.ts'
import { Context } from '@deepseek-ai/cordis'

const testToolSignal = new AbortController().signal

// ---- Mock MCP Client (copied small helpers from mcp-client.spec.ts) ----

interface MockTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  execution?: { taskSupport?: 'optional' | 'required' | 'forbidden' }
  _meta?: Record<string, unknown>
}

interface MockCallResult {
  content: JsonValue[]
  structuredContent?: JsonValue
  isError?: boolean
}

function createMockClient(tools: MockTool[], callResult: MockCallResult = { content: [{ type: 'text', text: 'ok' }] }) {
  const listTools = vi.fn(async (
    _params?: Record<string, unknown>,
  ): Promise<{ tools: MockTool[]; nextCursor: string | undefined }> => ({ tools, nextCursor: undefined }))
  const callTool = vi.fn(async (
    _params?: Record<string, unknown>,
    _compatibilitySchema?: unknown,
    _options?: unknown,
  ): Promise<Record<string, unknown>> => ({ ...callResult }))
  return {
    listTools,
    callTool,
    request: vi.fn(async (
      request: { method: string; params?: Record<string, unknown> },
      _schema: unknown,
      options?: unknown,
    ): Promise<unknown> => {
      if (request.method === 'tools/list') return listTools(request.params)
      if (request.method === 'tools/call') return callTool(request.params, undefined, options)
      throw new Error(`unexpected MCP request: ${request.method}`)
    }),
    setNotificationHandler: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

async function mountRegistry(options: { toolSearch?: boolean } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (options.toolSearch !== false) await ctx.plugin(DeferredToolRegistry)
  return ctx
}

function defaultOpts(overrides: Partial<ToolBridgeOptions> = {}): ToolBridgeOptions {
  return {
    registrationFailure: 'contain',
    serverName: 'srv',
    toolCallTimeoutMs: 60_000,
    ...overrides,
  }
}

const greetTool: MockTool = {
  name: 'greet',
  description: 'Say hello',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
}
const addTool: MockTool = {
  name: 'add',
  description: 'Add numbers',
  inputSchema: { type: 'object', properties: {} },
}

// ---- Tests ----

describe('deferred MCP tool disclosure', () => {
  let ctx: Context

  describe('eager path', () => {
    beforeEach(async () => {
      ctx = await mountRegistry()
    })

    it('A. default threshold, 2 tools, toolSearch present → eager register, registerDeferred never called', async () => {
      const spy = vi.spyOn(ctx.toolSearch, 'registerDeferred')
      const client = createMockClient([greetTool, addTool])

      const generation = await syncTools(client as never, ctx, defaultOpts(), emptyToolGeneration())

      expect(generation.disposers.size).toBe(2)
      expect(ctx.tools.get('mcp__srv__greet')).toBeDefined()
      expect(ctx.tools.get('mcp__srv__add')).toBeDefined()
      const names = ctx.tools.schemas().map(s => s.name)
      expect(names).toContain('mcp__srv__greet')
      expect(names).toContain('mcp__srv__add')
      expect(spy).not.toHaveBeenCalled()
      // Tool breakdown: all listed tools eager, none deferred.
      expect(generation.eagerCount).toBe(2)
      expect(generation.deferredCount).toBe(0)
      expect(generation.eagerCount + generation.deferredCount).toBe(generation.disposers.size)
    })

    it('D. no toolSearch service, deferToolThreshold 0 → eager register (standalone fallback)', async () => {
      const bare = await mountRegistry({ toolSearch: false })
      const client = createMockClient([greetTool, addTool])

      const generation = await syncTools(client as never, bare, defaultOpts({ deferToolThreshold: 0 }), emptyToolGeneration())

      expect(generation.disposers.size).toBe(2)
      expect(bare.tools.get('mcp__srv__greet')).toBeDefined()
      expect(bare.tools.get('mcp__srv__add')).toBeDefined()
    })
  })

  describe('deferred path', () => {
    beforeEach(async () => {
      ctx = await mountRegistry()
    })

    it('B. deferToolThreshold 0, toolSearch present → reserved not visible; activate then get + execute', async () => {
      const client = createMockClient([greetTool], { content: [{ type: 'text', text: 'ok' }] })

      const generation = await syncTools(client as never, ctx, defaultOpts({ deferToolThreshold: 0 }), emptyToolGeneration())

      expect(generation.disposers.size).toBe(1)
      expect(ctx.tools.get('mcp__srv__greet')).toBeUndefined()
      const names = ctx.tools.schemas().map(s => s.name)
      expect(names).not.toContain('mcp__srv__greet')
      // Reserved, not visible: the restriction universe knows the name.
      expect(ctx.tools.view().restrictableNames.has('mcp__srv__greet')).toBe(true)
      // Searchable through ToolSearch.
      const hits = ctx.toolSearch.search('greet')
      expect(hits.map(h => h.name)).toContain('mcp__srv__greet')

      // Activate then call it like any tool.
      const activation = ctx.toolSearch.activate('mcp__srv__greet')
      expect(activation.status).toBe('loaded')
      expect(ctx.tools.get('mcp__srv__greet')).toBeDefined()
      const result = await ctx.tools.execute({
        callId: ToolCallId('c1'), name: 'mcp__srv__greet', arguments: { name: 'World' }, signal: testToolSignal,
      })
      expect(result.isError).toBe(false)
      expect(result.content[0]).toEqual({ type: 'text', text: 'ok' })
      // Tool breakdown: the single listed tool deferred, nothing eager.
      expect(generation.eagerCount).toBe(0)
      expect(generation.deferredCount).toBe(1)
      expect(generation.eagerCount + generation.deferredCount).toBe(generation.disposers.size)
    })

    it('C. over-threshold server: alwaysLoad tool eager, sibling deferred', async () => {
      const eager: MockTool = { ...greetTool, _meta: { 'anthropic/alwaysLoad': true } }
      const client = createMockClient([eager, addTool])

      // Threshold 1: 2 listed tools ≥ 1 → defer mode for this sync.
      const generation = await syncTools(client as never, ctx, defaultOpts({ deferToolThreshold: 1 }), emptyToolGeneration())

      expect(ctx.tools.get('mcp__srv__greet')).toBeDefined()
      const names = ctx.tools.schemas().map(s => s.name)
      expect(names).toContain('mcp__srv__greet')
      expect(names).not.toContain('mcp__srv__add')
      expect(ctx.toolSearch.search('add').map(h => h.name)).toContain('mcp__srv__add')
      expect(generation.disposers.size).toBe(2)
      // Tool breakdown: alwaysLoad tool eager, sibling deferred.
      expect(generation.eagerCount).toBe(1)
      expect(generation.deferredCount).toBe(1)
      expect(generation.eagerCount + generation.deferredCount).toBe(generation.disposers.size)
    })

    it('E. deferred generation, identical second sync → no re-registerDeferred, same generation', async () => {
      const spy = vi.spyOn(ctx.toolSearch, 'registerDeferred')
      const client = createMockClient([greetTool])
      const opts = defaultOpts({ deferToolThreshold: 0 })

      const first = await syncTools(client as never, ctx, opts, emptyToolGeneration())
      const second = await syncTools(client as never, ctx, opts, first)

      expect(second).toBe(first)
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('F. description change under defer → new search text; previously activated tool is gone and searchable again', async () => {
      const client = createMockClient([greetTool])
      const opts = defaultOpts({ deferToolThreshold: 0 })

      const first = await syncTools(client as never, ctx, opts, emptyToolGeneration())
      expect(ctx.toolSearch.activate('mcp__srv__greet').status).toBe('loaded')
      expect(ctx.tools.get('mcp__srv__greet')).toBeDefined()

      // Change the description: fingerprint flips, a real swap happens.
      client.listTools.mockResolvedValue({
        tools: [{ ...greetTool, description: 'Say hello loudly' }],
        nextCursor: undefined,
      })
      const second = await syncTools(client as never, ctx, opts, first)
      expect(second).not.toBe(first)
      // The old activation was unloaded with the old generation.
      expect(ctx.tools.get('mcp__srv__greet')).toBeUndefined()
      const hits = ctx.toolSearch.search('greet')
      expect(hits.map(h => h.name)).toContain('mcp__srv__greet')
      // The new search text carries the new description.
      expect(hits.find(h => h.name === 'mcp__srv__greet')?.description).toContain('loudly')
      // The tool loads again on a fresh activation.
      expect(ctx.toolSearch.activate('mcp__srv__greet').status).toBe('loaded')
      expect(ctx.tools.get('mcp__srv__greet')).toBeDefined()
    })

    it('I. different client, same payload, deferred → swap happens; old disposer gone, new reservation present', async () => {
      const clientA = createMockClient([greetTool])
      const clientB = createMockClient([greetTool])
      const opts = defaultOpts({ deferToolThreshold: 0 })

      const first = await syncTools(clientA as never, ctx, opts, emptyToolGeneration())
      expect(ctx.toolSearch.activate('mcp__srv__greet').status).toBe('loaded')

      const second = await syncTools(clientB as never, ctx, opts, first)
      expect(second).not.toBe(first)
      // Old generation disposed (both reservation and activated definition gone).
      expect(ctx.tools.get('mcp__srv__greet')).toBeUndefined()
      // New reservation present and loadable against the new client.
      const hits = ctx.toolSearch.search('greet')
      expect(hits.map(h => h.name)).toContain('mcp__srv__greet')
      expect(ctx.toolSearch.activate('mcp__srv__greet').status).toBe('loaded')
      expect(ctx.tools.get('mcp__srv__greet')).toBeDefined()
      const result = await ctx.tools.execute({
        callId: ToolCallId('c1'), name: 'mcp__srv__greet', arguments: { name: 'World' }, signal: testToolSignal,
      })
      expect(result.isError).toBe(false)
      // The old client never gets the call.
      expect(clientA.callTool).not.toHaveBeenCalled()
    })
  })

  describe('conflict handling', () => {
    beforeEach(async () => {
      ctx = await mountRegistry()
    })

    it('G. forced-defer squat: pre-registered squatter survives; nothing reserved for the rolled-back generation', async () => {
      ctx.tools.register({
        name: 'mcp__srv__taken',
        description: 'Foreign squatter',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'null' }, render: () => [] },
        async execute() { return null },
      })
      const client = createMockClient([
        { name: 'free', description: 'Free tool', inputSchema: { type: 'object', properties: {} } },
        { name: 'taken', description: 'Squatted tool', inputSchema: { type: 'object', properties: {} } },
      ])
      const spy = vi.spyOn(ctx.toolSearch, 'registerDeferred')

      const generation = await syncTools(client as never, ctx, defaultOpts({ deferToolThreshold: 0 }), emptyToolGeneration())

      // Whole generation rolled back: no disposers kept.
      expect(generation.disposers.size).toBe(0)
      // The deferred entry for `free` was unwound with the rollback.
      expect(ctx.tools.view().restrictableNames.has('mcp__srv__free')).toBe(false)
      expect(ctx.toolSearch.search('free').map(h => h.name)).not.toContain('mcp__srv__free')
      // The squatter was never touched.
      expect(ctx.tools.get('mcp__srv__taken')).toBeDefined()
      // The conflict was detected at sync time (dispose-previous happened, publish failed).
      expect(spy).toHaveBeenCalled()
    })

    it('H. duplicate raw name in list → fetch-phase reject, nothing reserved', async () => {
      const client = createMockClient([
        { name: 'dup', description: 'first', inputSchema: { type: 'object', properties: {} } },
        { name: 'dup', description: 'second', inputSchema: { type: 'object', properties: {} } },
      ])

      await expect(
        syncTools(client as never, ctx, defaultOpts({ deferToolThreshold: 0 }), emptyToolGeneration()),
      ).rejects.toThrow(/more than once/)
      expect(ctx.tools.view().restrictableNames.has('mcp__srv__dup')).toBe(false)
      expect(ctx.toolSearch.search('dup').map(h => h.name)).not.toContain('mcp__srv__dup')
    })
  })
})
