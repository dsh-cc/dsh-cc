/**
 * Unit tests for the CC-style WebFetch tool: schema registration and prompt
 * section, raw passthrough without a prompt, cheap-lane summarization with a
 * configured `haiku` alias (exact route stamped, purpose omitted, prompt+page
 * fed to the LLM), hard failure when a prompt is given but the lane is
 * unconfigured (fetch must not run), error paths (blank url, seam failure,
 * tool-call summary output), and replacement of the stock `dsh-tool-web`
 * web_fetch under `fetch: false`.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import ToolRuntimeCC from '@dsh-cc/tools'
import * as ToolWebFetch from '@dsh-cc/tool-web-fetch'
import type { ModelRoutes } from '@dsh-cc/model-aliases'

const FETCH_RESULT = {
  url: 'https://example.com/x',
  statusCode: 200,
  body: { kind: 'html', content: '<p>Hello world</p>' },
  truncated: false,
} as const

const SUMMARY_SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'Extracted hello' },
  { type: 'finish', reason: { kind: 'stop' } },
]

interface SetupOptions {
  routes?: { resolve: (model: string | undefined) => { provider?: string; model?: string } | undefined }
  script?: readonly StreamChunk[]
  fetch?: (request: { url: string }, signal: AbortSignal) => Promise<typeof FETCH_RESULT>
}

async function setup(options: SetupOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntimeCC)
  const fetchMock = vi.fn(options.fetch ?? (async () => ({ ...FETCH_RESULT })))
  ctx.provide('web', { fetch: fetchMock } as never)
  const streams: GenerateOptions[] = []
  let script: readonly StreamChunk[] = options.script ?? SUMMARY_SCRIPT
  const fakeStream = vi.fn(async function * (streamOptions: GenerateOptions): AsyncIterable<StreamChunk> {
    streams.push(streamOptions)
    yield * script
  })
  ctx.provide('llm', { stream: fakeStream } as never)
  if (options.routes !== undefined) ctx.provide('ccModelRoutes', options.routes)
  await ctx.plugin(ToolWebFetch)
  return { ctx, streams, fetchMock }
}

let callCounter = 0
function call(ctx: Context, args: unknown, agent?: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`call-${++callCounter}`),
    name: 'web_fetch',
    arguments: args,
    ...(agent !== undefined ? { agent: agent as never } : {}),
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const CHEAP_ROUTES: ModelRoutes = {
  resolve: (model) => (model === 'haiku' ? { provider: 'p', model: 'cheap' } : undefined),
}

describe('web_fetch registration', () => {
  it('registers exactly one web_fetch with required url and optional prompt', async () => {
    const { ctx } = await setup()
    const schemas = ctx.tools.schemas().filter(s => s.name === 'web_fetch')
    expect(schemas).toHaveLength(1)
    expect(schemas[0]!.parameters).toMatchObject({
      type: 'object',
      properties: {
        url: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['url'],
    })
  })

  it('is concurrency-safe', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('web_fetch')?.isConcurrencySafe?.({ url: 'https://example.com' })).toBe(true)
  })

  it('system-prompt assemble includes the tool:web_fetch section mentioning prompt', async () => {
    const { ctx } = await setup()
    const provider = await ctx.systemPrompt.assemble()
    const text = JSON.stringify(provider)
    expect(text).toContain('prompt')
    expect(text).toContain('web_fetch')
    expect(text).toContain('fails if haiku is not configured')
  })
})

describe('raw passthrough (no prompt)', () => {
  it('does not call llm.stream and returns the raw fetch body', async () => {
    const { ctx, streams } = await setup()
    const result = await call(ctx, { url: 'https://example.com/x' })
    expect(result.isError).toBe(false)
    expect(streams).toHaveLength(0)
    expect(result.value).toMatchObject({
      url: 'https://example.com/x',
      statusCode: 200,
      body: { kind: 'html', content: '<p>Hello world</p>' },
      truncated: false,
    })
  })
})

describe('prompt summarization on the cheap lane', () => {
  it('streams once on the resolved haiku route and returns the summary text', async () => {
    const { ctx, streams } = await setup({ routes: CHEAP_ROUTES })
    const result = await call(ctx, { url: 'https://example.com/x', prompt: 'What does the page say?' })
    expect(result.isError).toBe(false)
    expect(streams).toHaveLength(1)
    const options = streams[0]!
    expect(options.provider).toBe('p')
    expect(options.model).toBe('cheap')
    expect(options.purpose).toBeUndefined()
    const userText = options.messages[0]!.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(userText).toContain('What does the page say?')
    // formatFetchOutput of `<p>Hello world</p>` must carry the converted text.
    expect(userText).toContain('Hello')
    expect(result.value).toMatchObject({
      body: { kind: 'text', content: 'Extracted hello' },
    })
  })

  it('fills a string-form haiku (model only) with the calling agent request-header provider', async () => {
    const { ctx, streams } = await setup({ routes: { resolve: (m) => (m === 'haiku' ? { model: 'cheap' } : undefined) } })
    const agent = { session: { requestHeader: () => ({ config: { provider: 'p', model: 'main' } }) } }
    const result = await call(ctx, { url: 'https://example.com/x', prompt: 'Summarize' }, agent)
    expect(result.isError).toBe(false)
    expect(streams).toHaveLength(1)
    expect(streams[0]!.provider).toBe('p')
    expect(streams[0]!.model).toBe('cheap')
  })

  it('fails hard for a string-form haiku without a calling agent (fetch not called)', async () => {
    const { ctx, streams, fetchMock } = await setup({ routes: { resolve: (m) => (m === 'haiku' ? { model: 'cheap' } : undefined) } })
    const result = await call(ctx, { url: 'https://example.com/x', prompt: 'Summarize' })
    expect(result.isError).toBe(true)
    expect(streams).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(text(result)).toMatch(/haiku/)
  })
})

describe('prompt with the cheap lane unconfigured', () => {
  it('fails hard without fetching or streaming (no routes service)', async () => {
    const { ctx, streams, fetchMock } = await setup()
    const result = await call(ctx, { url: 'https://example.com/x', prompt: 'Summarize' })
    expect(result.isError).toBe(true)
    expect(streams).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(text(result)).toMatch(/haiku/)
  })

  it('fails hard without fetching or streaming (routes resolve undefined)', async () => {
    const { ctx, streams, fetchMock } = await setup({ routes: { resolve: () => undefined } })
    const result = await call(ctx, { url: 'https://example.com/x', prompt: 'Summarize' })
    expect(result.isError).toBe(true)
    expect(streams).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(text(result)).toMatch(/haiku/)
  })

  it('still fetches on the cheap-lane success path', async () => {
    const { ctx, fetchMock } = await setup({ routes: CHEAP_ROUTES })
    const result = await call(ctx, { url: 'https://example.com/x', prompt: 'Summarize' })
    expect(result.isError).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('error paths', () => {
  it('rejects a blank url with an error mentioning url', async () => {
    const { ctx, streams } = await setup()
    const result = await call(ctx, { url: '   ' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/url/)
    expect(streams).toHaveLength(0)
  })

  it('surfaces a seam failure as isError without streaming', async () => {
    const { ctx, streams } = await setup({
      fetch: async () => { throw new Error('WEB_PROVIDER_UNAVAILABLE') },
    })
    const result = await call(ctx, { url: 'https://example.com/x' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/WEB_PROVIDER_UNAVAILABLE/)
    expect(streams).toHaveLength(0)
  })

  it('rejects a summary stream that requests a tool', async () => {
    const { ctx } = await setup({
      routes: CHEAP_ROUTES,
      script: [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: CallId('summary-tool'), name: 'unexpected', argumentsDelta: '{}' },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
    })
    const result = await call(ctx, { url: 'https://example.com/x', prompt: 'Summarize' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/tool/)
  })
})

describe('replacement of stock dsh-tool-web web_fetch', () => {
  it('mounts exactly one web_fetch (ours) next to a fetch:false stock tool-web', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntimeCC)
    await ctx.plugin(WebRuntime)
    ctx.provide('llm', { stream: async function * (): AsyncIterable<StreamChunk> {} } as never)
    await ctx.plugin(ToolWeb, { search: true, fetch: false })
    await ctx.plugin(ToolWebFetch)
    const schemas = ctx.tools.schemas().filter(s => s.name === 'web_fetch')
    expect(schemas).toHaveLength(1)
    expect(schemas[0]!.parameters).toMatchObject({
      properties: { prompt: { type: 'string' } },
    })
  })
})
