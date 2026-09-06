import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import type { SessionTitleProvider, SessionTitleProviderRequest } from '@deepseek-ai/dsh-session-title'
import * as provider from '@dsh-cc/session-title-provider'

const SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '  五个字标题  ' },
  { type: 'finish', reason: { kind: 'stop' } },
]

const CONFIG = {
  targetWords: 5,
  targetCjkCharacters: 10,
  maxInputBytes: 1_000,
  maxOutputTokens: 32,
  timeoutMs: 1_000,
} as const

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: readonly StreamChunk[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * this.script
  }
}

let nextSession = 0

function request(ctx: Context, signal = new AbortController().signal): SessionTitleProviderRequest {
  const session = ctx.sessions.create(SessionId(`title-call-${++nextSession}`))
  session.append('turn/start', { turn: 1 })
  const first = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'first prompt' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const second = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '第二个问题' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return {
    session,
    messages: [
      { seq: first.seq, text: 'first prompt' },
      { seq: second.seq, text: '第二个问题' },
    ],
    route: { provider: 'current-route', model: 'current-model' },
    signal,
  }
}

interface BootOptions {
  ccModelRoutes?: { resolve(model: string | undefined): { provider: string; model: string } | undefined }
  settings?: { get(namespace: string): unknown; register?: (namespace: string) => unknown }
  config?: provider.Config
}

/** Boot: SessionStore + LlmRuntime + a fake sessionTitle capturing every registration. */
async function harness(options: BootOptions = {}): Promise<{
  ctx: Context
  adapter: RecordingAdapter
  registrations: SessionTitleProvider[]
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  const adapter = new RecordingAdapter(SCRIPT)
  const registrations: SessionTitleProvider[] = []
  ctx.provide('sessionTitle', {
    register: vi.fn((candidate: SessionTitleProvider) => {
      registrations.push(candidate)
      return () => {}
    }),
  })
  if (options.ccModelRoutes !== undefined) ctx.provide('ccModelRoutes', options.ccModelRoutes)
  if (options.settings !== undefined) ctx.provide('settings', options.settings)
  provider.apply(ctx, options.config ?? { ...CONFIG })
  return { ctx, adapter, registrations }
}

describe('@dsh-cc/session-title-provider', () => {
  it('stamps the haiku route from the ccModelRoutes service', async () => {
    const { ctx, adapter, registrations } = await harness({
      ccModelRoutes: {
        resolve: model => model === 'haiku' ? { provider: 'haiku-p', model: 'haiku-m' } : undefined,
      },
    })
    ctx.llm.registerAdapter(['haiku-p'], adapter)
    const result = await registrations[0]!.generate(request(ctx))
    expect(adapter.requests[0]).toMatchObject({
      provider: 'haiku-p',
      model: 'haiku-m',
      purpose: 'session-title',
    })
    expect(result.title).toBe('五个字标题')
    expect(result.model).toEqual({ provider: 'haiku-p', model: 'haiku-m' })
  })

  it('stamps the haiku route from the model-aliases settings overlay', async () => {
    const register = vi.fn()
    const { ctx, adapter, registrations } = await harness({
      settings: {
        get: (namespace: string) =>
          namespace === 'model-aliases' ? { haiku: { provider: 'haiku-p', model: 'haiku-m' } } : undefined,
        register,
      },
    })
    ctx.llm.registerAdapter(['haiku-p'], adapter)
    const result = await registrations[0]!.generate(request(ctx))
    expect(adapter.requests[0]).toMatchObject({ provider: 'haiku-p', model: 'haiku-m' })
    expect(result.model).toEqual({ provider: 'haiku-p', model: 'haiku-m' })
    expect(register).not.toHaveBeenCalled()
  })

  it('stamps a string-form haiku (model only) by inheriting the logged request provider', async () => {
    const { ctx, adapter, registrations } = await harness({
      ccModelRoutes: {
        resolve: model => model === 'haiku' ? { model: 'haiku-m' } : undefined,
      },
    })
    ctx.llm.registerAdapter(['current-route'], adapter)
    const result = await registrations[0]!.generate(request(ctx))
    expect(adapter.requests[0]).toMatchObject({
      provider: 'current-route',
      model: 'haiku-m',
      purpose: 'session-title',
    })
    expect(result.model).toEqual({ provider: 'current-route', model: 'haiku-m' })
  })

  it('inherits the logged main route when no cheap lane is configured', async () => {
    const { ctx, adapter, registrations } = await harness()
    ctx.llm.registerAdapter(['current-route'], adapter)
    const result = await registrations[0]!.generate(request(ctx))
    expect(adapter.requests[0]).toMatchObject({
      provider: 'current-route',
      model: 'current-model',
      purpose: 'session-title',
    })
    expect(result.model).toEqual({ provider: 'current-route', model: 'current-model' })
  })

  it('lets an explicit provider+model config pair win over a configured haiku', async () => {
    const { ctx, adapter, registrations } = await harness({
      ccModelRoutes: {
        resolve: model => model === 'haiku' ? { provider: 'haiku-p', model: 'haiku-m' } : undefined,
      },
      config: { ...CONFIG, provider: 'explicit-route', model: 'explicit-model' },
    })
    ctx.llm.registerAdapter(['explicit-route'], adapter)
    const result = await registrations[0]!.generate(request(ctx))
    expect(adapter.requests[0]).toMatchObject({
      provider: 'explicit-route',
      model: 'explicit-model',
    })
    expect(result.model).toEqual({ provider: 'explicit-route', model: 'explicit-model' })
  })

  it('exposes loader-safe exports', () => {
    expect(provider.name).toBe('cc-session-title-provider')
    expect(provider.inject).toEqual(['sessionTitle', 'llm', 'sessions'])
    expect(typeof provider.apply).toBe('function')
    expect(SessionTitleProviderId(provider.name)).toBe(provider.name)
  })
})
