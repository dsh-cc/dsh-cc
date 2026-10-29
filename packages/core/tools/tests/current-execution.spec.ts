import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { currentToolExecution, type ToolDefinition, type ToolExecution, type ToolExecutionInput } from '@dsh-cc/tools'

const signal = new AbortController().signal
const input = (name: string, args: unknown = {}): ToolExecutionInput => ({ name, arguments: args, callId: ToolCallId('same-id'), signal })
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

function tool(name: string, execute: ToolDefinition['execute']): ToolDefinition {
  return { name, description: name, parameters: { type: 'object', properties: {} }, output: { schema: { type: 'null' }, render: () => [] }, execute }
}

describe('currentToolExecution', () => {
  it('exposes immutable runtime identity only during the body, across awaits, with separate tokens for reused call IDs', async () => {
    const ctx = await setup()
    const contexts: Readonly<ToolExecution>[] = []
    const otherStages: unknown[] = []
    const argumentsValue = { nested: { value: 'original' } }
    const agent = {} as Agent
    let policyExecution: ToolExecution | undefined
    ctx.on('tools/pre-execute', (exec, next) => {
      policyExecution = exec
      otherStages.push(currentToolExecution())
      return next()
    })
    ctx.on('tools/execute', async (_exec, next) => {
      otherStages.push(currentToolExecution())
      const result = await next()
      otherStages.push(currentToolExecution())
      return result
    })
    ctx.on('tools/post-execute', (_exec, _result, next) => {
      otherStages.push(currentToolExecution())
      return next()
    })
    ctx.on('tools/result', () => { otherStages.push(currentToolExecution()) })
    ctx.tools.register(tool('body', async (_args, exec) => {
      const current = currentToolExecution()!
      contexts.push(current)
      expect(current).not.toBe(exec)
      expect(current.token).toBe(policyExecution!.token)
      expect(current).toMatchObject({ name: 'body', callId: 'same-id', agent, arguments: argumentsValue, signal })
      expect(Object.isFrozen(current)).toBe(true)
      expect(Object.isFrozen(current.arguments)).toBe(true)
      expect(Object.isFrozen((current.arguments as typeof argumentsValue).nested)).toBe(true)
      expect(current.arguments).not.toBe(argumentsValue)
      await Promise.resolve()
      expect(currentToolExecution()).toBe(current)
      return null
    }))

    expect(currentToolExecution()).toBeUndefined()
    expect((await ctx.tools.execute({ ...input('body', argumentsValue), agent })).isError).toBe(false)
    expect((await ctx.tools.execute({ ...input('body', argumentsValue), agent })).isError).toBe(false)
    expect(contexts).toHaveLength(2)
    expect(contexts[0]!.token).not.toBe(contexts[1]!.token)
    expect(otherStages.every(value => value === undefined)).toBe(true)
    expect(currentToolExecution()).toBeUndefined()
  })

  it('isolates parallel bodies and restores the enclosing body after nested dispatch', async () => {
    const ctx = await setup()
    const started = deferred()
    const release = deferred()
    const identities = new Map<string, Readonly<ToolExecution>>()
    ctx.tools.register(tool('parallel', async args => {
      const key = (args as { key: string }).key
      const current = currentToolExecution()!
      identities.set(key, current)
      if (identities.size === 2) started.resolve()
      await release.promise
      expect(currentToolExecution()).toBe(current)
      return null
    }))
    const pending = Promise.all(['a', 'b'].map(key => ctx.tools.execute(input('parallel', { key }))))
    await Promise.race([started.promise, pending])
    expect(identities.size).toBe(2)
    expect(currentToolExecution()).toBeUndefined()
    expect(identities.get('a')!.token).not.toBe(identities.get('b')!.token)
    release.resolve()
    expect((await pending).every(result => !result.isError)).toBe(true)

    let outer: Readonly<ToolExecution> | undefined
    let inner: Readonly<ToolExecution> | undefined
    ctx.tools.register(tool('inner', async () => { inner = currentToolExecution(); return null }))
    ctx.tools.register(tool('outer', async () => {
      outer = currentToolExecution()
      expect((await ctx.tools.execute({ ...input('inner'), parent: outer!.token })).isError).toBe(false)
      expect(currentToolExecution()).toBe(outer)
      return null
    }))
    expect((await ctx.tools.execute(input('outer'))).isError).toBe(false)
    expect(inner!.token).not.toBe(outer!.token)
    expect(inner!.parent).toBe(outer!.token)
    expect(currentToolExecution()).toBeUndefined()
  })

  it.each([false, true])('invalidates detached continuations after body settlement (throws: %s)', async throws => {
    const ctx = await setup()
    const release = deferred()
    let detached!: Promise<Readonly<ToolExecution> | undefined>
    let bodyContext: Readonly<ToolExecution> | undefined
    ctx.tools.register(tool('body', async () => {
      bodyContext = currentToolExecution()
      detached = release.promise.then(() => currentToolExecution())
      if (throws) throw new Error('body failed')
      return null
    }))
    const result = await ctx.tools.execute(input('body'))
    expect(result.isError).toBe(throws)
    expect(bodyContext).toBeDefined()
    expect(currentToolExecution()).toBeUndefined()
    release.resolve()
    expect(await detached).toBeUndefined()
  })

  it('does not expose an execution when policy or an around wrapper skips the body', async () => {
    const ctx = await setup()
    let bodies = 0
    const observed: unknown[] = []
    ctx.tools.register(tool('body', async () => { bodies += 1; return null }))
    const stop = ctx.on('tools/pre-execute', () => {
      observed.push(currentToolExecution())
      return Promise.resolve({ kind: 'deny', reason: 'denied' } as const)
    })
    expect((await ctx.tools.execute(input('body'))).isError).toBe(true)
    stop()
    ctx.on('tools/execute', async () => {
      observed.push(currentToolExecution())
      return { isError: false, content: [], value: null }
    })
    expect((await ctx.tools.execute(input('body'))).isError).toBe(false)
    expect(bodies).toBe(0)
    expect(observed).toEqual([undefined, undefined])
  })

  it.each(['token', 'name', 'agent', 'callId', 'rootCallId', 'parent', 'arguments'])('rejects wrapper replacement of trusted %s before entering the body', async field => {
    const ctx = await setup()
    let bodies = 0
    ctx.tools.register(tool('body', async () => { bodies += 1; return null }))
    ctx.on('tools/execute', (exec, next) => {
      Object.defineProperty(exec, field, { configurable: true, value: field === 'arguments' ? {} : Symbol('forged') })
      return next()
    })
    const result = await ctx.tools.execute(input('body'))
    expect(result.isError).toBe(true)
    expect(bodies).toBe(0)
    expect(currentToolExecution()).toBeUndefined()
  })

  it('rejects wrapper accessors that could return different identities during dispatch', async () => {
    const ctx = await setup()
    let bodies = 0
    ctx.tools.register(tool('body', async () => { bodies += 1; return null }))
    ctx.on('tools/execute', (exec, next) => {
      const name = exec.name
      Object.defineProperty(exec, 'name', { configurable: true, get: () => name })
      return next()
    })
    expect((await ctx.tools.execute(input('body'))).isError).toBe(true)
    expect(bodies).toBe(0)
  })

  it('allows wrapper signal replacement while preserving the original signal in the trusted identity', async () => {
    const ctx = await setup()
    const replacement = new AbortController().signal
    let seenSignal: AbortSignal | undefined
    let identity: Readonly<ToolExecution> | undefined
    ctx.on('tools/execute', (exec, next) => { exec.signal = replacement; return next() })
    ctx.tools.register(tool('body', async (_args, exec) => {
      seenSignal = exec.signal
      identity = currentToolExecution()
      return null
    }))
    expect((await ctx.tools.execute(input('body'))).isError).toBe(false)
    expect(seenSignal).toBeDefined()
    expect(identity!.signal).toBe(signal)
  })
})
