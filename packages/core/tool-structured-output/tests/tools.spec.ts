/**
 * Unit tests for the StructuredOutput tool: the factory asserts its schema
 * subtype early and echoes validated input back in the CC-structured-output
 * envelope; each schema-type violation is rejected via the shared cc-tools
 * validation semantics; and the plugin registers the tool only when a schema
 * is declared.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime, { JsonSchemaError } from '@dsh-cc/tools'
import * as ToolStructuredOutput from '@dsh-cc/tool-structured-output'

const BUGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    count: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' } },
    enabled: { type: 'boolean' },
  },
  required: ['title', 'count'],
}

async function mount(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return { ctx, dispose: () => ctx.fiber.dispose() }
}

function registerAndCall(ctx: Context, args: unknown) {
  ctx.tools.register(ToolStructuredOutput.createStructuredOutputTool(BUGS_SCHEMA))
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('so-' + Math.random()),
    name: 'StructuredOutput',
    arguments: args,
  })
}

describe('createStructuredOutputTool factory', () => {
  it('rejects an unsupported schema at construction (early fail)', () => {
    expect(() => ToolStructuredOutput.createStructuredOutputTool({ type: 'array', minLength: 2 }))
      .toThrow(JsonSchemaError)
    expect(() => ToolStructuredOutput.createStructuredOutputTool({ type: 'object', required: ['nope'] }))
      .toThrow(JsonSchemaError)
  })

  it('produces a StructuredOutput tool whose parameters mirror the given schema and is concurrency-safe', () => {
    const tool = ToolStructuredOutput.createStructuredOutputTool(BUGS_SCHEMA)
    expect(tool.name).toBe('StructuredOutput')
    expect(tool.parameters).toEqual(BUGS_SCHEMA)
    expect(tool.isConcurrencySafe?.({})).toBe(true)
  })

  it('returns the CC structured-output envelope for a valid input', async () => {
    const { ctx, dispose } = await mount()
    const input = { title: 'a', count: 2, tags: ['x'], enabled: true }
    const result = await registerAndCall(ctx, input)
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      data: 'Structured output provided successfully',
      structured_output: input,
    })
    await dispose()
  })
})

describe('invalid input rejection (one violation per schema type)', () => {
  async function reject(args: unknown, reason: RegExp) {
    const { ctx, dispose } = await mount()
    const result = await registerAndCall(ctx, args)
    expect(result.isError).toBe(true)
    expect(result.error?.message).toMatch(reason)
    await dispose()
  }

  it('rejects a non-string value for a string property', async () => {
    await reject({ title: 42, count: 1 }, /title/)
  })

  it('rejects a non-integer value for an integer property', async () => {
    await reject({ title: 'a', count: 2.5 }, /count/)
  })

  it('rejects a non-string item in an array property', async () => {
    await reject({ title: 'a', count: 1, tags: [1] }, /tags/)
  })

  it('rejects a missing required property', async () => {
    await reject({ count: 1 }, /required|title/)
  })

  it('rejects an undeclared property under additionalProperties: false', async () => {
    await reject({ title: 'a', count: 1, stray: true }, /declared property|stray/)
  })

  it('rejects a non-boolean value for a boolean property', async () => {
    await reject({ title: 'a', count: 1, enabled: 'yes' }, /enabled/)
  })
})

describe('plugin registration paths', () => {
  it('registers a StructuredOutput tool when a schema is declared', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ToolStructuredOutput, { schema: BUGS_SCHEMA })
    expect(ctx.tools.schemas().map(s => s.name)).toEqual(['StructuredOutput'])
  })

  it('registers no tool when no schema is declared', async () => {
    const { ctx, dispose } = await mount()
    await ctx.plugin(ToolStructuredOutput)
    expect(ctx.tools.schemas()).toEqual([])
    await dispose()
  })
})
