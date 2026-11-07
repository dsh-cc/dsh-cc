/**
 * Execution-identity instrumentation contract (fork drift D2.1).
 *
 * The identity is active exactly around a call's BODY dispatch: the registry
 * registers ONE `tools/execute` listener (`src/index.ts`) that enters the
 * async-local context around the delegated `next()` — which upstream's
 * pipeline wraps around `dispatchToolBody`. That window contains the body's
 * own `approval/request` (where permission-rules grant-escalation reads the
 * identity) but NOT the `prepare()` guards (`tools/pre-execute`,
 * `checkGuards`), which run outside it.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { currentToolExecution, type ToolDefinition, type ToolExecution, type ToolExecutionInput } from '@dsh-cc/tools'
import { executeToolInvocation } from './executor-fixture.ts'

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
  it('exposes immutable runtime identity only during the body dispatch, across awaits, with separate tokens for reused call IDs', async () => {
    const ctx = await setup()
    const contexts: Readonly<ToolExecution>[] = []
    const otherStages: unknown[] = []
    const argumentsValue = { nested: { value: 'original' } }
    const agent = {} as Agent
    let policyExecution: ToolExecution | undefined
    ctx.on('tools/pre-execute', (exec, next) => {
      policyExecution = exec
      // The prepare() guards run OUTSIDE the wrap.
      otherStages.push({ stage: 'pre-execute', identity: currentToolExecution() })
      return next()
    })
    ctx.on('tools/execute', async (_exec, next) => {
      // This listener is registered AFTER the registry's own, so it runs INSIDE
      // the registry's wrap: the identity is already active on entry.
      otherStages.push({ stage: 'execute-enter', identity: currentToolExecution() })
      const result = await next()
      otherStages.push({ stage: 'execute-exit', identity: currentToolExecution() })
      return result
    })
    ctx.on('tools/post-execute', (_exec, _result, next) => {
      otherStages.push({ stage: 'post-execute', identity: currentToolExecution() })
      return next()
    })
    ctx.on('tools/result', () => { otherStages.push({ stage: 'result', identity: currentToolExecution() }) })
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
    expect((await executeToolInvocation(ctx, { ...input('body', argumentsValue), agent })).isError).toBe(false)
    expect((await executeToolInvocation(ctx, { ...input('body', argumentsValue), agent })).isError).toBe(false)
    expect(contexts).toHaveLength(2)
    expect(contexts[0]!.token).not.toBe(contexts[1]!.token)
    // The prepare() guards and the post/result stages are OUTSIDE the wrap; the
    // delegated `tools/execute` listeners are INSIDE it.
    const byStage = new Map(otherStages.map(entry => [(entry as { stage: string }).stage, (entry as { identity: unknown }).identity]))
    expect(byStage.get('pre-execute')).toBeUndefined()
    expect(byStage.get('post-execute')).toBeUndefined()
    expect(byStage.get('result')).toBeUndefined()
    expect(byStage.get('execute-enter')).toBeDefined()
    expect(byStage.get('execute-exit')).toBeDefined()
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
    const pending = Promise.all(['a', 'b'].map(key => executeToolInvocation(ctx, input('parallel', { key }))))
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
      expect((await executeToolInvocation(ctx, { ...input('inner'), parent: outer!.token })).isError).toBe(false)
      expect(currentToolExecution()).toBe(outer)
      return null
    }))
    expect((await executeToolInvocation(ctx, input('outer'))).isError).toBe(false)
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
    const result = await executeToolInvocation(ctx, input('body'))
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
    expect((await executeToolInvocation(ctx, input('body'))).isError).toBe(true)
    stop()
    ctx.on('tools/execute', async () => {
      observed.push(currentToolExecution())
      return { isError: false, content: [], value: null }
    })
    expect((await executeToolInvocation(ctx, input('body'))).isError).toBe(false)
    expect(bodies).toBe(0)
    // The denied prepare stage is outside the wrap; a wrapper that short-circuits
    // the body is INSIDE it (the window is the dispatch, not the body call).
    expect(observed[0]).toBeUndefined()
    expect(observed[1]).toBeDefined()
  })

  it.each(['token', 'name', 'agent', 'callId', 'rootCallId', 'parent', 'arguments'])(
    'keeps the trusted %s identity when a later wrapper replaces it on the dispatch object',
    async field => {
      // Restated for the new boundary: the identity host code observes is the
      // snapshot taken by the registry's OUTERMOST listener, so a later wrapper
      // mutating the mutable dispatch object cannot forge it.
      const ctx = await setup()
      let bodies = 0
      let observedIdentity: Readonly<ToolExecution> | undefined
      ctx.tools.register(tool('body', async () => {
        bodies += 1
        observedIdentity = currentToolExecution()
        return null
      }))
      ctx.on('tools/execute', (exec, next) => {
        Object.defineProperty(exec, field, { configurable: true, value: field === 'arguments' ? {} : Symbol('forged') })
        return next()
      })
      const result = await executeToolInvocation(ctx, input('body'))
      // A forged `name` also changes what the pipeline resolves, so that call
      // fails closed as an unknown tool; every other field swap still runs.
      if (field === 'name') {
        expect(result.isError).toBe(true)
        expect(bodies).toBe(0)
      } else {
        expect(result.isError).toBe(false)
        expect(bodies).toBe(1)
        expect(observedIdentity).toBeDefined()
        expect(observedIdentity!.name).toBe('body')
        expect(observedIdentity!.callId).toBe('same-id')
        expect(observedIdentity!.arguments).toEqual({})
      }
      expect(currentToolExecution()).toBeUndefined()
    },
  )

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
    expect((await executeToolInvocation(ctx, input('body'))).isError).toBe(false)
    expect(seenSignal).toBeDefined()
    expect(identity!.signal).toBe(signal)
  })
})
