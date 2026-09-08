import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@dsh-cc/tools'
import * as ToolStructuredOutput from '@dsh-cc/tool-structured-output'

const BUGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { title: { type: 'string' }, count: { type: 'integer' } },
  required: ['title', 'count'],
}

/** Mount the vendored ToolRuntime swap + the structured-output bundle row. */
async function mountTool(config?: Record<string, unknown>): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ToolStructuredOutput, config ?? {})
  return { ctx, dispose: () => ctx.fiber.dispose() }
}

describe('cc-shell bundle — tool-structured-output row (StructuredOutput over the vendored ToolRuntime)', () => {
  it('declaring a schema registers the StructuredOutput tool and marks it concurrency-safe', async () => {
    const { ctx, dispose } = await mountTool({ schema: BUGS_SCHEMA })
    expect(ctx.tools.schemas().map(s => s.name)).toEqual(['StructuredOutput'])
    expect(ctx.tools.get('StructuredOutput')?.isConcurrencySafe?.({})).toBe(true)
    await dispose()
  })

  it('without a declared schema no tool is registered', async () => {
    const { ctx, dispose } = await mountTool()
    expect(ctx.tools.schemas()).toEqual([])
    await dispose()
  })

  it('executes a valid structured output through the vendored ToolRuntime', async () => {
    const { ctx, dispose } = await mountTool({ schema: BUGS_SCHEMA })
    const input = { title: 'bug', count: 3 }
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('cc-structured-output'),
      name: 'StructuredOutput',
      arguments: input,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ data: 'Structured output provided successfully', structured_output: input })
    await dispose()
  })
})
