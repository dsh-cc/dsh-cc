import { describe, expect, it } from 'vitest'
import { streamSimple } from '@earendil-works/pi-ai/api/anthropic-messages'
import { streamSimple as streamSimpleOpenai } from '@earendil-works/pi-ai/api/openai-completions'
import type { Context, Model, Usage } from '@earendil-works/pi-ai'
import type { FetchFunction } from '@earendil-works/pi-ai'

/**
 * Placement-pin contract for pi-ai 0.85.1 prompt-cache markers (Phase 0,
 * sp-1): asserts WHERE `cache_control: { type: 'ephemeral' }` markers land in
 * the fully serialized request params (captured via `options.onPayload`
 * BEFORE any network) per dialect, and that `cacheRetention: 'none'`
 * suppresses them entirely. The stub fetch body only must not throw; the
 * assertions run purely on the onPayload params.
 */

const STUB_USAGE: Usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const anthropicModel: Model<'anthropic-messages'> = {
  id: 'claude-haiku-4-5',
  name: 'Claude Haiku 4.5',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4_096,
}

const openaiModel = (compat?: Record<string, unknown>): Model<'openai-completions'> => ({
  id: 'gpt-test',
  name: 'GPT Test',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
  ...(compat ? { compat: compat as never } : {}),
})

const context: Context = {
  systemPrompt: 'You are a test fixture system prompt.',
  messages: [
    { role: 'user', content: 'first user turn', timestamp: 1 },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'assistant reply' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      usage: STUB_USAGE,
      stopReason: 'stop',
      timestamp: 2,
    },
    { role: 'user', content: 'last user turn', timestamp: 3 },
  ],
  tools: [
    {
      name: 'tool_a',
      description: 'Tool A',
      parameters: { type: 'object', properties: { x: { type: 'string' } } },
    },
    {
      name: 'tool_b',
      description: 'Tool B',
      parameters: { type: 'object', properties: { y: { type: 'string' } } },
    },
  ],
}

/** Minimal non-throwing SSE stub keyed by dialect; body content is irrelevant. */
const stubFetch: FetchFunction = async (_url, init) => {
  const auth = new Headers(init?.headers).get('authorization') ?? ''
  const isOpenai = auth.startsWith('Bearer') && !auth.includes('sk-ant')
  const body = isOpenai
    ? [
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
        '',
      ].join('\n\n')
    : [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"m1","role":"assistant","model":"claude-haiku-4-5","usage":{"input_tokens":1,"output_tokens":0}}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function captureParams(
  model: Model<string>,
  options: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  let captured: Record<string, any> | undefined
  const streamFn = model.api === 'anthropic-messages' ? streamSimple : streamSimpleOpenai
  const events = streamFn(model as never, context, {
    apiKey: 'sk-test',
    fetch: stubFetch,
    onPayload: (payload: unknown) => {
      captured = payload as Record<string, any>
    },
    ...options,
  } as never)
  for await (const _event of events) {
    // drain; errors here do not matter, onPayload already fired
  }
  if (!captured) throw new Error('onPayload never fired')
  return captured
}

function collectCacheControl(value: unknown, found: Array<unknown> = []): Array<unknown> {
  if (Array.isArray(value)) {
    for (const item of value) collectCacheControl(item, found)
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'cache_control') found.push(child)
      else collectCacheControl(child, found)
    }
  }
  return found
}

describe('pi-ai 0.85.1 cache_control placement pins', () => {
  it('anthropic-messages default: ephemeral marker on system, last tool, last user message', async () => {
    const params = await captureParams(anthropicModel)

    // system
    const system = params.system as Array<Record<string, unknown>>
    expect(Array.isArray(system)).toBe(true)
    const systemWithMarker = system.filter(
      block => (block.cache_control as Record<string, unknown>)?.type === 'ephemeral',
    )
    expect(systemWithMarker.length).toBeGreaterThanOrEqual(1)

    // last tool entry
    const tools = params.tools as Array<Record<string, unknown>>
    expect(tools.length).toBeGreaterThanOrEqual(2)
    expect((tools[tools.length - 1].cache_control as Record<string, unknown>)?.type).toBe('ephemeral')
    expect((tools[tools.length - 2].cache_control ?? undefined)).toBeUndefined()

    // last conversation message
    const messages = params.messages as Array<Record<string, any>>
    const last = messages[messages.length - 1]
    expect(last.role).toBe('user')
    const lastBlock = Array.isArray(last.content)
      ? last.content[last.content.length - 1]
      : last.content
    expect(lastBlock.cache_control?.type).toBe('ephemeral')

    // marker count for the non-OAuth shape: system(1) + tools tail(1) + last message(1) = 3
    const all = collectCacheControl(params)
    expect(all.length).toBe(3)
  })

  it('anthropic-messages cacheRetention none: no cache_control anywhere', async () => {
    const params = await captureParams(anthropicModel, { cacheRetention: 'none' })
    expect(collectCacheControl(params)).toEqual([])
  })

  it('openai-completions without compat.cacheControlFormat: no cache_control anywhere', async () => {
    const params = await captureParams(openaiModel())
    expect(collectCacheControl(params)).toEqual([])
  })

  it('openai-completions with compat.cacheControlFormat anthropic: cache_control present', async () => {
    const params = await captureParams(openaiModel({ cacheControlFormat: 'anthropic' }))
    const all = collectCacheControl(params)
    expect(all.length).toBeGreaterThanOrEqual(1)
    for (const marker of all) {
      expect((marker as Record<string, unknown>).type).toBe('ephemeral')
    }
  })
})
