import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { runSideQuery } from '../src/index.ts'
import type { SideQueryOptions } from '../src/index.ts'

/** Plain text answer stream (the happy-path script). */
const TEXT_SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '答' },
  { type: 'text-delta', index: 0, text: '案' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '答案' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** Stream that emits a tool-call block (rogue side query). */
const TOOL_SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', callId: 'c1', name: 'web_fetch', input: {} } as unknown as never },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

/** Stream with no text block at all. */
const EMPTY_SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: '思考' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** Scripted adapter: replays chunks unless the signal aborts. */
class ReplayAdapter extends LlmAdapter {
  constructor(private readonly script: readonly StreamChunk[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    for (const chunk of this.script) {
      if (options.signal?.aborted) break
      yield chunk
    }
  }

  readonly calls: GenerateOptions[] = []
}

/** Adapter that hangs until its signal aborts, then ends without output. */
class HangingAdapter extends LlmAdapter {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) resolve()
      else options.signal?.addEventListener('abort', () => resolve(), { once: true })
    })
  }

  readonly calls: GenerateOptions[] = []
}

/** Adapter whose stream throws immediately. */
class ThrowingAdapter extends LlmAdapter {
  override async * stream(): AsyncIterable<StreamChunk> {
    this.calls.push({} as GenerateOptions)
    throw new Error('boom')
  }

  readonly calls: GenerateOptions[] = []
}

/** Agent stub with a request header completing the provider half. */
function agentWithConfig(): Agent {
  return {
    id: 'sess-42',
    session: {
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-v4-pro' } }),
    },
  } as unknown as Agent
}

/** Agent stub with no usable request header (provider half unfillable). */
function agentWithoutConfig(): Agent {
  return { id: 'sess-42' } as unknown as Agent
}

interface Boot {
  ctx: Context
  calls: () => GenerateOptions[]
}

async function boot(
  script: readonly StreamChunk[] = TEXT_SCRIPT,
  opts: { routes?: (alias: string | undefined) => { provider?: string; model?: string } | undefined } = {},
): Promise<Boot> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new ReplayAdapter(script)
  ctx.llm.registerAdapter(['deepseek'], adapter)
  if (opts.routes !== undefined) {
    ctx.provide('ccModelRoutes', { resolve: opts.routes })
  }
  return { ctx, calls: () => adapter.calls }
}

const PARENT = agentWithConfig()

function baseOpts(over: Partial<SideQueryOptions> = {}): SideQueryOptions {
  return { agent: PARENT, prompt: 'summarize this', ...over }
}

describe('@dsh-cc/side-query runSideQuery', () => {
  it('happy path: configured alias → ok with assembled text, inheritedRoute false', async () => {
    const { ctx } = await boot(TEXT_SCRIPT, { routes: (a) => (a === 'haiku' ? { model: 'haiku-model' } : undefined) })
    const result = await runSideQuery(ctx, baseOpts())
    expect(result).toMatchObject({ ok: true, text: '答案', inheritedRoute: false })
    expect(typeof (result as { durationMs?: number }).durationMs).toBe('number')
  })

  it('unrouted + onUnrouted skip → reason unrouted, adapter never invoked', async () => {
    const { ctx, calls } = await boot()
    const result = await runSideQuery(ctx, baseOpts({ agent: agentWithoutConfig(), onUnrouted: 'skip' }))
    expect(result).toEqual({ ok: false, reason: 'unrouted' })
    expect(calls()).toHaveLength(0)
  })

  it('unrouted + default inherit → adapter invoked on parent route, inheritedRoute true', async () => {
    const { ctx, calls } = await boot(TEXT_SCRIPT)
    const result = await runSideQuery(ctx, baseOpts({ agent: PARENT }))
    expect(result).toMatchObject({ ok: true, text: '答案', inheritedRoute: true })
    expect(calls()).toHaveLength(1)
    expect(calls()[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-pro' })
  })

  it('hanging adapter + timeoutMs 50 → reason timeout', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new HangingAdapter()
    ctx.llm.registerAdapter(['deepseek'], adapter)
    const result = await runSideQuery(ctx, baseOpts({ timeoutMs: 50 }))
    expect(result).toMatchObject({ ok: false, reason: 'timeout' })
    expect(adapter.calls).toHaveLength(1)
  })

  it('pre-aborted caller signal → reason timeout, adapter not invoked', async () => {
    const { ctx, calls } = await boot(TEXT_SCRIPT)
    const controller = new AbortController()
    controller.abort()
    const result = await runSideQuery(ctx, baseOpts({ signal: controller.signal }))
    expect(result).toMatchObject({ ok: false, reason: 'timeout' })
    expect(calls()).toHaveLength(0)
  })

  it('tool-call block rejected → reason error', async () => {
    const { ctx } = await boot(TOOL_SCRIPT, { routes: (a) => (a === 'haiku' ? { model: 'haiku-model' } : undefined) })
    const result = await runSideQuery(ctx, baseOpts())
    expect(result).toMatchObject({ ok: false, reason: 'error' })
  })

  it('no text assembled → reason empty', async () => {
    const { ctx } = await boot(EMPTY_SCRIPT, { routes: (a) => (a === 'haiku' ? { model: 'haiku-model' } : undefined) })
    const result = await runSideQuery(ctx, baseOpts())
    expect(result).toMatchObject({ ok: false, reason: 'empty' })
  })

  it('adapter throw never escapes → reason error', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new ThrowingAdapter()
    ctx.llm.registerAdapter(['deepseek'], adapter)
    const result = await runSideQuery(ctx, baseOpts({ agent: PARENT }))
    expect(result).toMatchObject({ ok: false, reason: 'error' })
  })

  it('alias resolving to model-only route with unfillable provider → unrouted even on inherit', async () => {
    const { ctx, calls } = await boot(TEXT_SCRIPT, { routes: (a) => (a === 'haiku' ? { model: 'cheap-model' } : undefined) })
    const result = await runSideQuery(ctx, baseOpts({ agent: agentWithoutConfig() }))
    expect(result).toEqual({ ok: false, reason: 'unrouted' })
    expect(calls()).toHaveLength(0)
  })
})
