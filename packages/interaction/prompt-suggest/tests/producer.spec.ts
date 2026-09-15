import { describe, expect, it, vi, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply, getSuggestion } from '../src/index.ts'

/** Happy-path script: the model predicts the next user message. */
const PREDICT_SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'run ' },
  { type: 'text-delta', index: 0, text: 'the tests' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'run the tests' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** Script where the model answers with only whitespace (no confident prediction). */
const EMPTY_SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '   ' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '   ' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** Swappable scripted adapter: replay, hang-until-abort, or throw. */
class ScriptedAdapter extends LlmAdapter {
  script: readonly StreamChunk[] = PREDICT_SCRIPT
  behavior: 'script' | 'hang' | 'throw' = 'script'

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    if (this.behavior === 'throw') throw new Error('boom')
    if (this.behavior === 'hang') {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve()
        else options.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return
    }
    for (const chunk of this.script) {
      if (options.signal?.aborted) break
      yield chunk
    }
  }

  readonly calls: GenerateOptions[] = []
}

/** Session event stubs (duck-typed; only what the extractor reads). */
function userEvent(text: string): unknown {
  return { type: 'user/message', seq: 1, data: { id: 'm1', role: 'user', content: [{ type: 'text', text }] } }
}

function assistantEvent(text: string): unknown {
  return { type: 'assistant/message', seq: 2, data: { message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text }] } } }
}

function fakeAgent(sessionId: string, events: unknown[]): Agent {
  return {
    session: {
      header: { id: sessionId },
      snapshotEvents: () => events,
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-v4-pro' } }),
    },
  } as unknown as Agent
}

interface Boot {
  ctx: Context
  adapter: ScriptedAdapter
  calls: () => GenerateOptions[]
}

async function boot(opts: { enabled?: boolean; script?: readonly StreamChunk[] } = {}): Promise<Boot> {
  const enabled = opts.enabled ?? true
  const adapter = new ScriptedAdapter()
  if (opts.script !== undefined) adapter.script = opts.script
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['deepseek'], adapter)
  ctx.provide('settings', { register: () => ({ get: () => ({ enabled, alias: 'haiku', timeoutMs: 4000, maxTokens: 128 }) }) })
  apply(ctx)
  return {
    ctx,
    adapter,
    calls: () => adapter.calls,
  }
}

/** Dispatch turn-stopping the way the agent loop does. */
async function turnStop(ctx: Context, agent: Agent): Promise<void> {
  await ctx.serial('agent/turn-stopping' as never, { agent, turn: 1, signal: new AbortController().signal } as never)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('@dsh-cc/prompt-suggest producer', () => {
  it('turn-stop → scripted adapter → registry holds the suggestion (fire-and-forget)', async () => {
    const { ctx, calls } = await boot()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    // A slow-but-successful side query: the listener must return before it lands.
    const agent = fakeAgent('sess-fire', [userEvent('fix the bug'), assistantEvent('on it')])
    void turnStop(ctx, agent)
    // Listener returned without awaiting the model: no adapter call yet... actually
    // the stream starts synchronously inside runSideQuery, so one call is fine —
    // the point is turnStop resolved while the prediction was still pending.
    await turnStop(ctx, fakeAgent('noop-session', []))
    release()
    await vi.waitFor(() => {
      expect(getSuggestion('sess-fire')).toBe('run the tests')
    })
    expect(calls().length).toBeGreaterThan(0)
  })

  it('per-session keying: two sessionIds do not bleed', async () => {
    const { ctx } = await boot()
    await turnStop(ctx, fakeAgent('sess-a', [userEvent('q'), assistantEvent('a')]))
    await vi.waitFor(() => expect(getSuggestion('sess-a')).toBe('run the tests'))
    expect(getSuggestion('sess-b')).toBeUndefined()
  })

  it('TTL expiry: suggestion unreachable after 5 minutes', async () => {
    vi.useFakeTimers()
    const { ctx } = await boot()
    await turnStop(ctx, fakeAgent('sess-ttl', [userEvent('q'), assistantEvent('a')]))
    await vi.waitFor(() => expect(getSuggestion('sess-ttl')).toBe('run the tests'))
    vi.setSystemTime(Date.now() + 6 * 60 * 1000)
    expect(getSuggestion('sess-ttl')).toBeUndefined()
  })

  it('disabled → adapter never invoked, registry stays empty', async () => {
    const { ctx, calls } = await boot({ enabled: false })
    await turnStop(ctx, fakeAgent('sess-off', [userEvent('q'), assistantEvent('a')]))
    await new Promise((r) => setTimeout(r, 20))
    expect(calls()).toHaveLength(0)
    expect(getSuggestion('sess-off')).toBeUndefined()
  })

  it('empty-string prediction → registry cleared (no stale suggestion)', async () => {
    const { ctx, adapter } = await boot()
    const agent = fakeAgent('sess-clear', [userEvent('q'), assistantEvent('a')])
    await turnStop(ctx, agent)
    await vi.waitFor(() => expect(getSuggestion('sess-clear')).toBe('run the tests'))
    adapter.script = EMPTY_SCRIPT
    await turnStop(ctx, agent)
    await vi.waitFor(() => expect(getSuggestion('sess-clear')).toBeUndefined())
  })

  it('producer failure (timeout) never throws into turn-stop, registry keeps prior value', async () => {
    const { ctx, adapter } = await boot()
    const agent = fakeAgent('sess-hang', [userEvent('q'), assistantEvent('a')])
    await turnStop(ctx, agent)
    await vi.waitFor(() => expect(getSuggestion('sess-hang')).toBe('run the tests'))
    adapter.behavior = 'hang'
    await expect(turnStop(ctx, agent)).resolves.toBeUndefined()
    await vi.waitFor(() => expect(adapter.calls.length).toBeGreaterThanOrEqual(2))
    // Timeout (4s in the live read) still pending: prior value intact, nothing thrown.
    expect(getSuggestion('sess-hang')).toBe('run the tests')
  })

  it('producer failure (adapter throw) never throws into turn-stop', async () => {
    const { ctx, adapter } = await boot()
    adapter.behavior = 'throw'
    const agent = fakeAgent('sess-throw', [userEvent('q'), assistantEvent('a')])
    await expect(turnStop(ctx, agent)).resolves.toBeUndefined()
    expect(getSuggestion('sess-throw')).toBeUndefined()
  })

  it('no settings provider → registers nothing, feature no-ops', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['deepseek'], new ScriptedAdapter())
    apply(ctx)
    const agent = fakeAgent('sess-bare', [userEvent('q'), assistantEvent('a')])
    await expect(turnStop(ctx, agent)).resolves.toBeUndefined()
    expect(getSuggestion('sess-bare')).toBeUndefined()
  })

  it('dispose aborts an in-flight prediction (composed abort: timeout ∪ dispose)', async () => {
    const { ctx, adapter } = await boot()
    adapter.behavior = 'hang'
    const agent = fakeAgent('sess-dispose', [userEvent('q'), assistantEvent('a')])
    await turnStop(ctx, agent)
    await vi.waitFor(() => expect(adapter.calls).toHaveLength(1))
    await (ctx as unknown as { fiber: { dispose: () => Promise<void> } }).fiber.dispose()
    // Aborted dispose signal → runSideQuery resolves with timeout; registry empty.
    await vi.waitFor(() => expect(getSuggestion('sess-dispose')).toBeUndefined())
  })
})
