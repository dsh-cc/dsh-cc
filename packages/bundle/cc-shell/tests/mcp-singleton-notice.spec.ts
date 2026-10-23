/**
 * Runtime-scoped one-shot marks for the cc-shell MCP notices (design §D):
 * both preset standing mounts share one registry instance, so the marks are
 * keyed on that instance — first caller fires, every later caller no-ops, and
 * a distinct registry instance gets its own marks.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { McpConnectionsService } from '@dsh-cc/mcp-client'
import { markGatingNoticeFired, markNoticeFired } from '../src/mcpSingleton.ts'

/** A standalone registry instance on a throwaway context. */
async function makeRegistry(): Promise<McpConnectionsService> {
  const ctx = new Context()
  await ctx.plugin({
    name: 'cc-mcp-connections',
    apply(c: Context) {
      new McpConnectionsService(c)
    },
  })
  return ctx.get('mcpConnections') as McpConnectionsService
}

describe('markNoticeFired', () => {
  it('fires once per registry instance, independently across instances', async () => {
    const first = await makeRegistry()
    const second = await makeRegistry()

    expect(markNoticeFired(first)).toBe(true)
    expect(markNoticeFired(first)).toBe(false)
    expect(markNoticeFired(second)).toBe(true)
    expect(markNoticeFired(second)).toBe(false)
  })

  it('keeps the gating mark independent of the pending-notice mark', async () => {
    const registry = await makeRegistry()

    expect(markNoticeFired(registry)).toBe(true)
    expect(markGatingNoticeFired(registry)).toBe(true)
    expect(markGatingNoticeFired(registry)).toBe(false)
    expect(markNoticeFired(registry)).toBe(false)
  })
})
