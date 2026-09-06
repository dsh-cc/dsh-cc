/**
 * Unit tests for the Sleep model tool over a bare ToolRuntime: schema
 * registration and concurrency marking, cooperative cancellation through
 * `exec.signal`, a real fake-timer wait, duration validation (0, negative,
 * non-numeric), and the pure presentation functions.
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_ABORTED } from '@dsh-cc/tools'
import * as ToolSleep from '@dsh-cc/tool-sleep'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ToolSleep)
  return { ctx }
}

let callCounter = 0
function call(ctx: Context, signal: AbortSignal, args: unknown) {
  return ctx.tools.execute({ signal, callId: CallId(`call-${++callCounter}`), name: 'Sleep', arguments: args })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Sleep registration', () => {
  it('registers a single Sleep tool by default', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.schemas().map(s => s.name)).toEqual(['Sleep'])
  })

  it('exposes the CC-aligned description and a required numeric duration parameter', async () => {
    const { ctx } = await setup()
    const tool = ctx.tools.get('Sleep')!
    expect(tool.description).toContain('Wait for a specified duration')
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { duration: { type: 'number' } },
      required: ['duration'],
    })
  })

  it('is concurrency-safe and self-cleaning on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(ToolSleep)
    expect(ctx.tools.schemas()).toHaveLength(1)
    expect(ctx.tools.get('Sleep')?.isConcurrencySafe?.({ duration: 1 })).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
  })
})

describe('Sleep duration validation', () => {
  it('accepts zero as a no-op sleep', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, new AbortController().signal, { duration: 0 })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ duration: 0 })
  })

  it('rejects a negative duration', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, new AbortController().signal, { duration: -1 })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/duration/i)
  })

  it('rejects a non-numeric duration', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, new AbortController().signal, { duration: 'oops' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/duration/i)
  })

  it('rejects a missing duration', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, new AbortController().signal, {})
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/duration/i)
  })
})

describe('Sleep execution', () => {
  it('waits for a short duration before settling successfully', async () => {
    vi.useFakeTimers()
    const { ctx } = await setup()
    const promise = call(ctx, new AbortController().signal, { duration: 0.1 })

    let settled = false
    promise.then(() => { settled = true }, () => { settled = true })
    // Flush the synchronous dispatch so the body's timer is armed.
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(100)
    const result = await promise
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ duration: 0.1 })
    expect(settled).toBe(true)
  })

  it('aborts cooperatively when exec.signal fires mid-sleep, matching CC cancel behavior', async () => {
    vi.useFakeTimers()
    const { ctx } = await setup()
    const controller = new AbortController()
    const promise = call(ctx, controller.signal, { duration: 60 })

    await Promise.resolve()
    await Promise.resolve()

    controller.abort()
    // The body observes the abort without waiting for the 60s timer.
    const result = await promise
    expect(result.isError).toBe(true)
    expect(result.error?.info).toMatchObject({ name: 'AbortError', code: TOOL_ABORTED })
    expect(result.error?.message).toMatch(/aborted/i)
  })
})

describe('Sleep presentation', () => {
  it('presentCall / presentResult are pure functions of args', async () => {
    const { ctx } = await setup()
    const tool = ctx.tools.get('Sleep')!

    expect(tool.presentCall?.({ duration: 5 })).toMatchObject({
      card: 'generic',
      kind: 'execute',
      title: 'Sleeping',
      rawInput: '5 seconds',
    })

    expect(tool.presentResult?.(
      { duration: 5 },
      { content: [{ type: 'text', text: 'Slept for 5 seconds.' }], isError: false },
    )).toEqual({ card: 'generic', content: [{ type: 'text', text: 'Slept for 5 seconds.' }] })
  })
})
