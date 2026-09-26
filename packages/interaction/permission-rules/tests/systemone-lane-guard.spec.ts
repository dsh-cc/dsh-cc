/**
 * The System One chat guard must not disturb the legitimate System One
 * consumer: with the REAL `cc-model-routes` service mounted (its `llm/stream`
 * guard live) and gauge armed via the blessed settings form, the permission
 * classifier still resolves the systemone backend and classifies over the
 * native protocol — while the same model on the chat path is refused.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@dsh-cc/tools'
import { apply as applyModelRoutes, SystemOneChatModelError } from '@dsh-cc/model-aliases'
import { resolveClassifierBackend } from '../src/gauge-backend.ts'
import { createWarnOnce, resetPolicyWarned } from '../src/route-policy.ts'
import { classifyViaSystemOne, prepareSystemOneInput } from '../src/gauge-adapter.ts'

const OK_BODY = '{"model":"laya-rl-agent","answers":{"verdict":{"type":"choice","choice":"allow","probabilities":{"allow":0.9,"ask":0.05,"deny":0.05},"confidence":0.8}},"usage":{"input_tokens":83,"output_tokens":0}}'

const NAMESPACES: Record<string, unknown> = {
  'model-aliases': { gauge: { provider: 'orchestrix', model: 'llmbox_systemone/laya', protocol: 'systemone' }, haiku: { provider: 'orchestrix', model: 'llmbox_ant/haiku' } },
  'llm-pi-ai': { providers: { orchestrix: { baseURL: 'http://127.0.0.1:8080' } } },
}

async function mount(): Promise<Context> {
  const ctx = new Context()
  ctx.provide('settings', { get: (ns: string) => NAMESPACES[ns], register: () => ({}) })
  applyModelRoutes(ctx, {})
  return ctx
}

const exec = { name: 'Bash', arguments: { command: 'git status' } } as unknown as ToolExecution

describe('permission-rules System One lane with the chat guard mounted', () => {
  it('armed gauge still resolves to the systemone backend and classifies normally', async () => {
    resetPolicyWarned()
    const ctx = await mount()
    const backend = await resolveClassifierBackend(ctx, exec, {
      route: undefined,
      backend: 'auto',
      warnOnce: createWarnOnce(() => {}),
      resolveChatRoute: (_exec, name) => ({ provider: 'orchestrix', model: name }),
    })
    expect(backend).toEqual({ backend: 'systemone', provider: 'orchestrix', model: 'llmbox_systemone/laya', baseURL: 'http://127.0.0.1:8080' })
    const fetchImpl = vi.fn(async () => new Response(OK_BODY, { status: 200 }))
    const prepared = prepareSystemOneInput(exec, { hardDeny: [], softDeny: [], allowExceptions: [], environment: [] })
    const verdict = await classifyViaSystemOne(prepared, backend as { baseURL: string; model: string }, { timeoutMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(verdict.verdict).toBe('allow')
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8080/v1/systemone', expect.objectContaining({ method: 'POST' }))
  })

  it('the same System One model on the chat path (llm/stream) is refused', async () => {
    const ctx = await mount()
    const inner = vi.fn(async function * () { /* would be the adapter */ })
    const waterfall = (ctx as unknown as { waterfall(thisArg: unknown, name: string, options: unknown, next: () => unknown): unknown }).waterfall
    expect(() => waterfall.call(ctx, null, 'llm/stream', { provider: 'orchestrix', model: 'llmbox_systemone/laya', messages: [] }, inner))
      .toThrow(SystemOneChatModelError)
    expect(inner).not.toHaveBeenCalled()
    waterfall.call(ctx, null, 'llm/stream', { provider: 'orchestrix', model: 'llmbox_ant/haiku', messages: [] }, inner)
    expect(inner).toHaveBeenCalledTimes(1)
  })
})
