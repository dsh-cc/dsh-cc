/**
 * Regression test for the cc-shell glue's MCP registry ownership: the
 * `mcpConnections` registry must survive a first-server startup failure.
 * A `.mcp.json` whose FIRST server is broken (and, per the mcp-config loader,
 * hardcodes failOnStartupError=true) used to roll back the mcp-client fiber —
 * disposing the lazily instance-provided registry with it AND aborting the
 * remaining servers in the same file. The glue must own the registry from a
 * dedicated fiber and isolate per-server mount failures: the healthy server
 * still mounts ready and the registry stays observable for `/mcp`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import { apply, Config as GlueConfig } from '../src/index.ts'
import * as GlueModule from '../src/index.ts'

/** A ZERO-dependency MCP stdio server: newline-delimited JSON-RPC on stdio. */
const FIXTURE_SERVER = `
import { createInterface } from 'node:readline'

const respond = (id, result) => {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  // Notifications carry no id; ignore them (e.g. notifications/initialized).
  if (message.id === undefined || message.id === null) return
  switch (message.method) {
    case 'initialize':
      respond(message.id, {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'fixture', version: '1.0.0' },
      })
      break
    case 'tools/list':
      respond(message.id, {
        tools: [{ name: 'ping', description: 'pong', inputSchema: { type: 'object', properties: {} } }],
      })
      break
    default:
      break
  }
})
`

/** Write the zero-dep fixture stdio server into the temp dir; returns its path. */
function writeFixtureServer(): string {
  const fixturePath = join(tmp, 'fixture-server.mjs')
  writeFileSync(fixturePath, FIXTURE_SERVER, 'utf8')
  return fixturePath
}

let tmp: string
let previousDshHome: string | undefined

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cc-shell-mcp-registry-'))
  previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
})

afterEach(() => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  rmSync(tmp, { recursive: true, force: true })
})

describe('cc-shell glue MCP registry ownership', () => {
  it('keeps the registry and mounts later servers when an earlier server fails at startup', async () => {
    const fixturePath = writeFixtureServer()
    // Object key order matters: the failing server comes first so its mount
    // precedes the healthy one.
    const mcpJsonPath = join(tmp, '.mcp.json')
    writeFileSync(mcpJsonPath, JSON.stringify({
      mcpServers: {
        'bad-first': { type: 'stdio', command: 'definitely-not-a-real-binary-dsh-cc', args: [] },
        'good-second': { type: 'stdio', command: process.execPath, args: [fixturePath] },
      },
    }), 'utf8')

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)

    await apply(ctx, { pluginDirs: [], mcpConfigFiles: [mcpJsonPath] })

    const registry = ctx.get('mcpConnections')
    expect(registry).toBeDefined()
    // Deferred mounts no longer fail the fiber: the bad server is registered
    // (it reports an error) and the healthy server still reaches ready.
    await vi.waitFor(() => {
      expect(registry!.entries().find(e => e.name === 'bad-first')?.state).toBe('error')
    })
    await vi.waitFor(() => {
      expect(registry!.entries().find(e => e.name === 'good-second')).toMatchObject({ name: 'good-second', state: 'ready' })
    })
  }, 30_000)

  it('Config({}) keeps absent fields undefined so discovery fallbacks fire', () => {
    const validated = GlueConfig({})
    expect(validated.mcpConfigFiles).toBeUndefined()
    expect(validated.pluginDirs).toBeUndefined()
    expect(GlueConfig({ mcpConfigFiles: [] }).mcpConfigFiles).toEqual([])
  })

  it('discovers $DSH_HOME/.mcp.json when mounted without config (loader schema path)', async () => {
    const fixturePath = writeFixtureServer()
    writeFileSync(join(tmp, '.mcp.json'), JSON.stringify({
      mcpServers: {
        'tdd-discovery-fixture': { type: 'stdio', command: process.execPath, args: [fixturePath] },
      },
    }), 'utf8')

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)

    const savedDshHome = process.env.DSH_HOME
    try {
      process.env.DSH_HOME = tmp
      // Mount EXACTLY like the loader does: no config object, so cordis
      // validates the absent config through the module's Config schema.
      await ctx.plugin(GlueModule)
    } finally {
      if (savedDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = savedDshHome
    }

    const registry = ctx.get('mcpConnections')
    expect(registry).toBeDefined()
    // Presence only: cwd/.mcp.json and ~/.claude(.json) defaults may add more
    // entries on a given machine; the fixture server must simply be among them.
    await vi.waitFor(() => {
      expect(registry!.entries().find(e => e.name === 'tdd-discovery-fixture'))
        .toMatchObject({ name: 'tdd-discovery-fixture', state: 'ready' })
    })
  }, 30_000)
})
