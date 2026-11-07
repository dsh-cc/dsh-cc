import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@dsh-cc/tools'
import * as ToolSleep from '@dsh-cc/tool-sleep'
import * as CcToolExecutor from '@dsh-cc/tools/executor'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'

/** Mount the vendored ToolRuntime swap + the tool-sleep bundle row. */
async function mountToolSleep(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // Upstream split execution into pluggable executors: a composition that
  // assembles tools must select one (the fork executor's native mode).
  await ctx.plugin(CcToolExecutor)
  await ctx.plugin(ToolSleep)
  return { ctx, dispose: () => ctx.fiber.dispose() }
}

describe('cc-shell bundle — tool-sleep row (Sleep over the vendored ToolRuntime)', () => {
  it('registers the Sleep tool and marks it concurrency-safe', async () => {
    const { ctx, dispose } = await mountToolSleep()
    expect(ctx.tools.schemas().map(s => s.name)).toEqual(['Sleep'])
    expect(ctx.tools.get('Sleep')?.isConcurrencySafe?.({ duration: 1 })).toBe(true)
    await dispose()
  })

  it('executes a zero-duration Sleep without error', async () => {
    const { ctx, dispose } = await mountToolSleep()
    const result = await executeModelToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('cc-sleep-zero'),
      name: 'Sleep',
      arguments: { duration: 0 },
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ duration: 0 })
    await dispose()
  })
})
