/**
 * Integration test for the plugin MCP seam against the REAL `@dsh-cc/mcp-client`
 * and the package's fixture stdio MCP server: registering a server through the
 * seam mounts its `mcp__probe__*` tools and an `mcpConnections` entry; the
 * seam's disposer unmounts both; a same-name re-register after dispose succeeds
 * cleanly through the seam's pending-release ledger (D8).
 *
 * The fixture server is consumed the same way mcp-client's own e2e suite
 * consumes it: spawned over stdio via `process.execPath` (it self-executes a
 * stdio transport at module load and exports nothing, so importing it would
 * start a server inside the vitest process).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import type { McpConnectionsService } from '@dsh-cc/mcp-client'
import * as CcMcpClient from '@dsh-cc/mcp-client'
import { createPluginMcpSeam } from '../src/mcpSeam.ts'

// The mcp-client fixture: a real stdio MCP server exposing add/greet/... tools.
const fixtureServerPath = new URL('../../../../packages/mcp/mcp-client/tests/fixture-server.ts', import.meta.url).pathname

let ctx: Context

beforeEach(async () => {
  ctx = new Context()
  // The canonical mcp-client composition: tools runtime (mcp-client injects
  // 'tools') plus the system prompt it requires.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // The registry must outlive a single mcp-client instance (the glue does the
  // same): provide it from a child fiber that is ACTIVE before any instance
  // mounts, so the dispose → re-register cycle keeps one registry.
  if (ctx.get('mcpConnections') === undefined) {
    await ctx.plugin({
      name: 'test-mcp-connections',
      apply(c: Context) {
        new CcMcpClient.McpConnectionsService(c)
      },
    })
  }
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

function registry(): McpConnectionsService {
  return ctx.get('mcpConnections') as McpConnectionsService
}

function toolNames(): string[] {
  return (ctx.tools.schemas() as { name: string }[]).map(schema => schema.name)
}

describe('cc-shell plugin MCP seam — real mcp-client integration', () => {
  it('registers a fixture stdio server → tool + registry entry; dispose unmounts; same-name re-register succeeds', async () => {
    const registered: string[] = []
    const seam = createPluginMcpSeam(ctx, { onRegistered: n => registered.push(n) })

    const dispose = seam.registerServer('probe', {
      type: 'stdio',
      command: process.execPath,
      args: [fixtureServerPath],
    })
    expect(registered).toEqual(['probe'])

    // The mcp__probe__* tools mount once the handshake completes.
    await vi.waitFor(() => {
      expect(toolNames()).toContain('mcp__probe__add')
      expect(toolNames()).toContain('mcp__probe__greet')
    })
    const entry = registry().entries().find(e => e.name === 'probe')
    expect(entry).toBeDefined()
    expect(entry!.state).toBe('ready')

    // Dispose: the tool unregisters and the registry entry goes away.
    dispose()
    await vi.waitFor(() => {
      expect(toolNames().some(n => n.startsWith('mcp__probe__'))).toBe(false)
    })
    expect(registry().entries().find(e => e.name === 'probe')).toBeUndefined()

    // Same-name re-register after dispose: the pending-release ledger path —
    // clean remount, no duplicate-namespace rejection.
    const registered2: string[] = []
    const seam2 = createPluginMcpSeam(ctx, { onRegistered: n => registered2.push(n) })
    const dispose2 = seam2.registerServer('probe', {
      type: 'stdio',
      command: process.execPath,
      args: [fixtureServerPath],
    })
    expect(registered2).toEqual(['probe'])
    await vi.waitFor(() => {
      expect(toolNames()).toContain('mcp__probe__add')
    })
    expect(registry().entries().filter(e => e.name === 'probe')).toHaveLength(1)
    dispose2()
  })
})
