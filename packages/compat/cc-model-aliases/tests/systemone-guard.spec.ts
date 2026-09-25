/**
 * System One chat-path guard (gauge misuse): the resolver keeps the System One
 * protocol marker on resolved routes, and the `cc-model-routes` service's
 * `llm/stream` boundary rejects a System One model with a named error before
 * any adapter is reached — for hand-built one-shots AND for real spawned
 * child agents — while ordinary chat routes keep flowing.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'
import {
  SYSTEMONE_CHAT_MODEL_ERROR_CODE,
  SystemOneChatModelError,
  apply as applyModelAliases,
  createModelInspector,
  createModelResolver,
  findSystemOneTarget,
  isSystemOneRoute,
  mergeAliasMaps,
  toAgentOptions,
  toOneShotRoute,
} from '../src/index.ts'

/** The blessed arming form (settings overlay) for the System One gauge lane. */
const BLESSED = {
  gauge: { provider: 'mock', model: 'llmbox_systemone/laya', protocol: 'systemone' },
  haiku: { provider: 'mock', model: 'haiku-chat' },
} as const

function resolverOver(aliases: Record<string, unknown>) {
  return createModelResolver(() => mergeAliasMaps(undefined, aliases as never), { warn: () => {} })
}

describe('resolver keeps the System One protocol marker', () => {
  it('configured gauge resolves with protocol "systemone" (resolve, resolveDetailed, inspect)', () => {
    const resolve = resolverOver(BLESSED)
    expect(resolve('gauge')).toEqual({ provider: 'mock', model: 'llmbox_systemone/laya', protocol: 'systemone' })
    expect(resolve.resolveDetailed('gauge')).toEqual({
      selector: 'gauge',
      via: 'alias',
      route: { provider: 'mock', model: 'llmbox_systemone/laya', protocol: 'systemone' },
    })
    const inspect = createModelInspector(() => mergeAliasMaps(undefined, BLESSED as never), { warn: () => {} })
    expect(inspect('gauge').route?.protocol).toBe('systemone')
  })

  it('the marker survives a $level suffix and a one-hop string alias pointing at gauge', () => {
    const resolve = resolverOver({ ...BLESSED, judge: 'gauge' })
    expect(resolve('gauge$high')).toMatchObject({ model: 'llmbox_systemone/laya', protocol: 'systemone', reasoningEffort: 'high' })
    expect(resolve('judge')).toMatchObject({ model: 'llmbox_systemone/laya', protocol: 'systemone' })
  })

  it('a System One family model id is marked even without an explicit protocol field', () => {
    const resolve = resolverOver({ gauge: { provider: 'p', model: 'llmbox_systemone/laya' } })
    expect(isSystemOneRoute(resolve('gauge'))).toBe(true)
    expect(isSystemOneRoute(resolve('llmbox_systemone/laya'))).toBe(true)
  })

  it('ordinary chat routes carry no marker (unconfigured gauge follows haiku as before)', () => {
    const resolve = resolverOver({ haiku: BLESSED.haiku })
    expect(resolve('gauge')).toEqual({ provider: 'mock', model: 'haiku-chat' })
    expect(resolve('haiku')).not.toHaveProperty('protocol')
    expect(resolve('deepseek-chat')).toEqual({ model: 'deepseek-chat' })
  })

  it('chat projections refuse a System One route (fail fast before any spawn / one-shot)', () => {
    const route = resolverOver(BLESSED)('gauge')
    expect(() => toAgentOptions(route)).toThrow(SystemOneChatModelError)
    expect(() => toOneShotRoute(route)).toThrow(/System One model "mock\/llmbox_systemone\/laya" cannot be used as a chat model/)
    // Ordinary routes project exactly as before; the marker never leaks.
    const haiku = resolverOver(BLESSED)('haiku')
    expect(toAgentOptions(haiku)).toEqual({ provider: 'mock', model: 'haiku-chat' })
    expect(toOneShotRoute(haiku)).toEqual({ provider: 'mock', model: 'haiku-chat' })
  })

  it('findSystemOneTarget matches by model (and pinned provider), not by alias name', () => {
    const aliases = mergeAliasMaps(undefined, BLESSED as never)
    expect(findSystemOneTarget(aliases, 'mock', 'llmbox_systemone/laya')).toEqual({ alias: 'gauge' })
    expect(findSystemOneTarget(aliases, 'mock', 'haiku-chat')).toBeUndefined()
    const custom = mergeAliasMaps(undefined, { judge: { provider: 'gw', model: 'laya', protocol: 'systemone' } } as never)
    expect(findSystemOneTarget(custom, 'gw', 'laya')).toEqual({ alias: 'judge' })
    expect(findSystemOneTarget(custom, 'other', 'laya')).toBeUndefined()
  })
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Real llm runtime + the routes service (its `llm/stream` guard) under one context. */
async function mountGuarded(aliases: Record<string, unknown> = BLESSED, withSubagents = false) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  if (withSubagents) {
    const root = mkdtempSync(join(tmpdir(), 'dsh-systemone-guard-'))
    roots.push(root)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  }
  const adapter = new MockAdapter([textResponse('one'), textResponse('two'), textResponse('three')])
  ctx.llm.registerAdapter(['mock'], adapter)
  applyModelAliases(ctx, { modelAliases: aliases as never })
  return { ctx, adapter }
}

async function drain(ctx: Context, route: { provider: string; model: string }): Promise<void> {
  const messages = [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })]
  for await (const _chunk of ctx.llm.stream({ ...route, messages })) { /* drain */ }
}

describe('chat boundary rejects System One models (llm/stream guard)', () => {
  it('a one-shot chat call on the resolved gauge model throws SystemOneChatModelError and never reaches the adapter', async () => {
    const { ctx, adapter } = await mountGuarded()
    const routes = ctx.get('ccModelRoutes') as { resolve(m: string): { provider: string; model: string } }
    // Hand-built request (the projection helpers would already refuse): the
    // boundary must reject it on the provider/model pair alone.
    const { provider, model } = routes.resolve('gauge')
    const route = { provider, model }
    const error = await drain(ctx, route).then(() => undefined, (e: unknown) => e)
    expect(error).toBeInstanceOf(SystemOneChatModelError)
    expect((error as SystemOneChatModelError).code).toBe(SYSTEMONE_CHAT_MODEL_ERROR_CODE)
    const message = (error as Error).message
    expect(message).toContain('"mock/llmbox_systemone/laya"') // names the model
    expect(message).toContain('model alias "gauge"')
    expect(message).toContain('cannot be used as a chat model') // why
    expect(message).toContain('permission-rules') // where to go instead
    expect(adapter.requests).toHaveLength(0)
  })

  it('a literal System One model id is rejected even when no alias declares it', async () => {
    const { ctx, adapter } = await mountGuarded({ haiku: BLESSED.haiku })
    await expect(drain(ctx, { provider: 'mock', model: 'llmbox_systemone/laya' })).rejects.toThrow(SystemOneChatModelError)
    expect(adapter.requests).toHaveLength(0)
  })

  it('ordinary chat routes (haiku, unconfigured gauge → haiku peer) still reach the adapter', async () => {
    const { ctx, adapter } = await mountGuarded({ haiku: BLESSED.haiku })
    const routes = ctx.get('ccModelRoutes') as { resolve(m: string): never }
    await drain(ctx, toOneShotRoute(routes.resolve('haiku'))!)
    await drain(ctx, toOneShotRoute(routes.resolve('gauge'))!)
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]).toMatchObject({ provider: 'mock', model: 'haiku-chat' })
  })

  it('a real spawned child pinned to the gauge model (projection bypassed) is blocked before any model request', async () => {
    const { ctx, adapter } = await mountGuarded(BLESSED, true)
    const warns: string[] = []
    const logger = ctx.logger as unknown as { warn: (message: string) => void }
    const originalWarn = logger.warn.bind(logger)
    logger.warn = (message: string) => { warns.push(String(message)); originalWarn(message) }
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'haiku-chat' })
    const routes = ctx.get('ccModelRoutes') as { resolve(m: string): { model: string } }
    const subagents = ctx.get('subagents') as {
      start(name: string, request: Record<string, unknown>): Promise<{ result: Promise<{ stopReason: string; error?: unknown }> }>
    }
    const run = await subagents.start('spawn', {
      prompt: [{ type: 'text', text: 'work' }],
      parent: parent as Agent,
      signal: new AbortController().signal,
      agentOptions: { provider: 'mock', model: routes.resolve('gauge').model },
    })
    const settled = await run.result
    expect(settled.stopReason).toBe('error')
    expect(adapter.requests).toHaveLength(0)
    expect(warns.some(message => message.includes('System One model "mock/llmbox_systemone/laya"'))).toBe(true)
  })
})
