import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import * as WebFetchHttp from '@deepseek-ai/dsh-web-fetch-http'
import * as CcToolExecutor from '@dsh-cc/tools/executor'

function toolNames(ctx: Context): string[] {
  return ctx.tools.schemas().map(s => s.name)
}

/** The dsh-web seam + a real HTTP(S) fetch provider, as the cc-shell bundle rows wire it. */
async function mountWebSeam(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // Upstream split execution into pluggable executors: a composition that
  // assembles tools must select one (the fork executor's native mode).
  await ctx.plugin(CcToolExecutor)
  await ctx.plugin(WebRuntime)
  await ctx.plugin(WebFetchHttp, {
    timeoutMs: 20000,
    maxResponseBytes: 2000000,
    maxRedirects: 3,
  })
  return { ctx, dispose: () => ctx.fiber.dispose() }
}

describe('cc-shell bundle — web rows (tool-web fetch:true over a real seam)', () => {
  it('mounts both web_search and web_fetch when fetch is enabled', async () => {
    const { ctx, dispose } = await mountWebSeam()
    await ctx.plugin(ToolWeb, { fetch: true, searchTimeoutMs: 60000 })
    const names = toolNames(ctx)
    expect(names).toContain('web_search')
    expect(names).toContain('web_fetch')
    // The bundle's egress cap is applied by a REAL provider wired into ctx.web
    // (not a stub), so the seam is genuinely live for execution.
    expect(ctx.web).toBeDefined()
    await dispose()
  })

  it('hides web_fetch (but keeps web_search) when fetch is disabled', async () => {
    const { ctx, dispose } = await mountWebSeam()
    await ctx.plugin(ToolWeb, { search: true, fetch: false })
    const names = toolNames(ctx)
    expect(names).toContain('web_search')
    expect(names).not.toContain('web_fetch')
    await dispose()
  })
})
