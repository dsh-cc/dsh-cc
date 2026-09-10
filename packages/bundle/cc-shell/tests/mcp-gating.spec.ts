/**
 * Tests for the cc-shell glue's gated MCP discovery: when a dsh-native config
 * (`<cwd>/.mcp.json` or `$DSH_HOME/.mcp.json`) declares at least one server,
 * Claude Code config files are skipped with a warn + one-shot session-start
 * notice pointing at `/mcp migrate`; `mcpLoadClaudeFiles: true` restores the
 * old all-merge behavior and an explicit `mcpConfigFiles` list bypasses
 * gating entirely.
 *
 * The repo root has no `.mcp.json`, so `process.cwd()` contributes no dsh
 * project file — the tests only seed `$DSH_HOME`, `$CLAUDE_CONFIG_DIR`, and
 * `$HOME` tmp trees.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import { apply } from '../src/index.ts'

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

let tmp: string
let dshHome: string
let claudeDir: string
let home: string
let fixturePath: string
let previous: Record<'DSH_HOME' | 'CLAUDE_CONFIG_DIR' | 'HOME', string | undefined>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cc-shell-mcp-gating-'))
  dshHome = join(tmp, 'dsh')
  claudeDir = join(tmp, 'claude')
  home = join(tmp, 'home')
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(claudeDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  fixturePath = join(tmp, 'fixture-server.mjs')
  writeFileSync(fixturePath, FIXTURE_SERVER, 'utf8')
  previous = {
    DSH_HOME: process.env.DSH_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    HOME: process.env.HOME,
  }
  process.env.DSH_HOME = dshHome
  process.env.CLAUDE_CONFIG_DIR = claudeDir
  // `os.homedir()` follows $HOME on POSIX, so this relocates ~/.claude.json.
  process.env.HOME = home
})

afterEach(() => {
  for (const key of ['DSH_HOME', 'CLAUDE_CONFIG_DIR', 'HOME'] as const) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
  rmSync(tmp, { recursive: true, force: true })
})

/** Write a dsh-native config declaring the given server names. */
function writeDshConfig(names: string[]): string {
  const file = join(dshHome, '.mcp.json')
  const servers: Record<string, unknown> = {}
  for (const name of names) servers[name] = { type: 'stdio', command: process.execPath, args: [fixturePath] }
  writeFileSync(file, JSON.stringify({ mcpServers: servers }), 'utf8')
  return file
}

/** Write a Claude Code config (`.mcp.json` under $CLAUDE_CONFIG_DIR and `~/.claude.json`). */
function writeClaudeConfigs(names: string[]): { claudeMcpJson: string; claudeDotJson: string } {
  const claudeMcpJson = join(claudeDir, '.mcp.json')
  const claudeDotJson = join(home, '.claude.json')
  const servers: Record<string, unknown> = {}
  for (const name of names) servers[name] = { type: 'stdio', command: process.execPath, args: [fixturePath] }
  writeFileSync(claudeMcpJson, JSON.stringify({ mcpServers: servers }), 'utf8')
  writeFileSync(claudeDotJson, JSON.stringify({ mcpServers: servers }), 'utf8')
  return { claudeMcpJson, claudeDotJson }
}

/** A fixture server whose initialize response is delayed by MCP_FIXTURE_DELAY_MS (from its config env). */
const FIXTURE_SLOW_SERVER = `
import { createInterface } from 'node:readline'

const respond = (id, result) => {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}

const delayMs = Number(process.env.MCP_FIXTURE_DELAY_MS || '0')

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.id === undefined || message.id === null) return
  if (message.method === 'initialize') {
    const reply = () => respond(message.id, {
      protocolVersion: '2025-03-26',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'fixture-slow', version: '1.0.0' },
    })
    if (delayMs > 0) setTimeout(reply, delayMs)
    else reply()
    return
  }
  if (message.method === 'tools/list') {
    respond(message.id, {
      tools: [{ name: 'ping', description: 'pong', inputSchema: { type: 'object', properties: {} } }],
    })
  }
})
`

/**
 * Write a dsh-native config where `slowNames` get a delayed-handshake fixture
 * (delay via the entry env) and the rest use the fast fixture.
 */
function writeDshConfigMixed(fastNames: string[], slowNames: string[], delayMs: number): string {
  const slowPath = join(tmp, 'fixture-slow-server.mjs')
  writeFileSync(slowPath, FIXTURE_SLOW_SERVER, 'utf8')
  const file = join(dshHome, '.mcp.json')
  const servers: Record<string, unknown> = {}
  for (const name of fastNames) servers[name] = { type: 'stdio', command: process.execPath, args: [fixturePath] }
  for (const name of slowNames) {
    servers[name] = { type: 'stdio', command: process.execPath, args: [slowPath], env: { MCP_FIXTURE_DELAY_MS: String(delayMs) } }
  }
  writeFileSync(file, JSON.stringify({ mcpServers: servers }), 'utf8')
  return file
}

/** Fresh cordis context with the runtime surfaces the glue needs. */
async function newCtx(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

/** Emit `agent/session-start` twice with a stub agent capturing injected messages. */
function emitSessionStartTwice(ctx: Context): unknown[] {
  const captured: unknown[] = []
  const agent = { inject: (message: unknown) => captured.push(message) }
  for (let i = 0; i < 2; i++) ctx.emit(ctx, 'agent/session-start', { agent, source: 'startup' })
  return captured
}

/**
 * Deferred mounts (`deferStartupConnect: true`) activate without awaiting the
 * handshake; wait until the named server reaches `ready` in the registry.
 */
async function awaitReady(registry: { entries(): { name: string; state: string }[] }, name: string): Promise<void> {
  await vi.waitFor(() => {
    expect(registry.entries().find(e => e.name === name)).toMatchObject({ name, state: 'ready' })
  })
}

describe('cc-shell glue gated MCP discovery', () => {
  it('gates claude files behind a non-empty dsh config and notices once', async () => {
    writeDshConfig(['server-a'])
    const { claudeMcpJson } = writeClaudeConfigs(['server-b'])
    const warns: string[] = []
    const ctx = await newCtx()
    const realWarn = ctx.logger.warn.bind(ctx.logger)
    ctx.logger.warn = (message: string, ...rest: unknown[]) => {
      warns.push(String(message))
      realWarn(message, ...rest)
    }

    await apply(ctx, { pluginDirs: [] })

    const registry = ctx.get('mcpConnections')
    await awaitReady(registry!, 'server-a')
    const entries = registry!.entries()
    expect(entries.some(e => e.name === 'server-b')).toBe(false)
    expect(warns.some(w => w.includes('/mcp migrate'))).toBe(true)

    const captured = emitSessionStartTwice(ctx)
    expect(captured).toHaveLength(1)
    const text = JSON.stringify(captured[0])
    expect(text).toContain('/mcp migrate')
    expect(text).toContain(claudeMcpJson)
  }, 30_000)

  it('mounts claude files ungated when no dsh config exists (no notice)', async () => {
    const { claudeMcpJson } = writeClaudeConfigs(['server-b-ungated'])

    const ctx = await newCtx()
    await apply(ctx, { pluginDirs: [] })

    const registry = ctx.get('mcpConnections')
    await awaitReady(registry!, 'server-b-ungated')

    const captured = emitSessionStartTwice(ctx)
    expect(captured).toHaveLength(0)
    expect(claudeMcpJson).toBeDefined()
  }, 30_000)

  it('mounts claude files when the dsh config is empty (gate requires >=1 declared server)', async () => {
    writeFileSync(join(dshHome, '.mcp.json'), JSON.stringify({ mcpServers: {} }), 'utf8')
    writeClaudeConfigs(['server-b-empty-dsh'])

    const ctx = await newCtx()
    await apply(ctx, { pluginDirs: [] })

    const registry = ctx.get('mcpConnections')
    await awaitReady(registry!, 'server-b-empty-dsh')
    expect(emitSessionStartTwice(ctx)).toHaveLength(0)
  }, 30_000)

  it('mcpLoadClaudeFiles: true restores the all-merge behavior with no notice', async () => {
    writeDshConfig(['server-a-escape'])
    writeClaudeConfigs(['server-b-escape'])

    const ctx = await newCtx()
    await apply(ctx, { mcpLoadClaudeFiles: true, pluginDirs: [] })

    const registry = ctx.get('mcpConnections')
    await awaitReady(registry!, 'server-a-escape')
    await awaitReady(registry!, 'server-b-escape')
    expect(emitSessionStartTwice(ctx)).toHaveLength(0)
  }, 30_000)

  it('an explicit mcpConfigFiles list bypasses gating entirely', async () => {
    writeDshConfig(['server-a-explicit'])
    const { claudeDotJson } = writeClaudeConfigs(['server-b-explicit'])

    const ctx = await newCtx()
    await apply(ctx, { mcpConfigFiles: [claudeDotJson], pluginDirs: [] })

    const registry = ctx.get('mcpConnections')
    await awaitReady(registry!, 'server-b-explicit')
    const entries = registry!.entries()
    expect(entries.some(e => e.name === 'server-a-explicit')).toBe(false)
    expect(emitSessionStartTwice(ctx)).toHaveLength(0)
  }, 30_000)
})

describe('cc-shell glue deferred MCP mounts', () => {
  it('mounts with deferStartupConnect: true (apply returns while the handshake is pending)', async () => {
    writeDshConfigMixed(['fast-server'], ['slow-server'], 5_000)
    const ctx = await newCtx()

    await apply(ctx, { pluginDirs: [] })

    const registry = ctx.get('mcpConnections')
    // The defer signature: apply resolved while the slow server is still
    // handshaking, and the fast fixture has already settled.
    const slow = registry!.entries().find(e => e.name === 'slow-server')
    expect(slow).toMatchObject({ name: 'slow-server', state: 'connecting' })
    await awaitReady(registry!, 'fast-server')

    // Cleanup: kill the still-connecting child.
    await registry!.disconnect('slow-server')
  }, 30_000)

  it('injects a one-shot connecting notice listing only the unsettled servers', async () => {
    writeDshConfigMixed(['fast-notice'], ['slow-notice'], 5_000)
    const ctx = await newCtx()

    await apply(ctx, { pluginDirs: [] })
    await awaitReady(ctx.get('mcpConnections')!, 'fast-notice')

    const captured = emitSessionStartTwice(ctx)
    expect(captured).toHaveLength(1)
    const text = JSON.stringify(captured[0])
    expect(text).toContain('slow-notice')
    expect(text).not.toContain('fast-notice')

    // Cleanup: kill the still-connecting child.
    await ctx.get('mcpConnections')!.disconnect('slow-notice')
  }, 30_000)

  it('mounts the settle follow-up: the pre-step gets one ready notice once the slow server settles', async () => {
    writeDshConfigMixed(['fast-rn'], ['slow-rn'], 5_000)
    const ctx = await newCtx()

    await apply(ctx, { pluginDirs: [] })
    await awaitReady(ctx.get('mcpConnections')!, 'fast-rn')

    const captured: unknown[] = []
    const agent = { session: { id: 'rn-1' }, inject: (message: unknown) => captured.push(message) }
    ctx.emit(ctx, 'agent/session-start', { agent, source: 'startup' })
    expect(captured).toHaveLength(1)
    expect(JSON.stringify(captured[0])).toContain('slow-rn')

    const drive = (): Promise<unknown> => ctx.waterfall(
      ctx as never,
      'agent/pre-step',
      { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }),
    )
    const appendedTexts = (decision: unknown): string[] => {
      const messages = (decision as { messages?: { content?: { type: string; text?: string }[] }[] }).messages ?? []
      return messages.flatMap(message => (message.content ?? []).flatMap(block => block.type === 'text' && block.text?.startsWith('MCP:') ? [block.text] : []))
    }

    // Slow server still handshaking → no settle text yet.
    const r1 = await drive()
    expect(JSON.stringify(r1)).not.toContain('servers ready')

    const registry = ctx.get('mcpConnections')!
    await vi.waitFor(() => {
      expect(registry.entries().find(e => e.name === 'slow-rn')).toMatchObject({ name: 'slow-rn', state: 'ready' })
    }, { timeout: 10_000 })
    const r2 = await drive()
    const texts = appendedTexts(r2)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('servers ready')
    expect(texts[0]).toContain('slow-rn')

    // Wrong-sid agent (driven between settle and delivery) is a bystander —
    // and the right-sid drive above already consumed the one-shot.
    const third = await drive()
    expect(appendedTexts(third)).toEqual([])

    // Cleanup: disconnect the fixture servers.
    await registry.disconnect('fast-rn')
    await registry.disconnect('slow-rn')
  }, 30_000)

  it('no settle follow-up when every server settled before session start', async () => {
    writeDshConfig(['rn-settled-a'])
    const ctx = await newCtx()

    await apply(ctx, { pluginDirs: [] })
    const registry = ctx.get('mcpConnections')!
    await awaitReady(registry, 'rn-settled-a')

    const captured: unknown[] = []
    const agent = { session: { id: 'rn-2' }, inject: (message: unknown) => captured.push(message) }
    ctx.emit(ctx, 'agent/session-start', { agent, source: 'startup' })
    expect(captured).toHaveLength(0)

    for (const turn of [1, 2]) {
      const decision = await ctx.waterfall(
        ctx as never,
        'agent/pre-step',
        { agent, messages: [], turn, step: 1, signal: new AbortController().signal },
        async () => ({ kind: 'enter', messages: [] }),
      )
      expect(JSON.stringify(decision)).not.toContain('MCP:')
    }

    await registry.disconnect('rn-settled-a')
  }, 30_000)

  // Production admission note (per critic review): this test drives
  // `ctx.waterfall` directly on the glue's own ctx, bypassing production's
  // fused `agentEvents` dispatch/scope filter. Production admission rests on
  // untagged listeners being admitted globally (dsh-scope), which the
  // existing still-connecting notice already relies on.

  it('suppresses the connecting notice when every server settles before the mount loop ends', async () => {
    writeDshConfig(['settled-a', 'settled-b'])
    const ctx = await newCtx()

    await apply(ctx, { pluginDirs: [] })
    const registry = ctx.get('mcpConnections')
    await awaitReady(registry!, 'settled-a')
    await awaitReady(registry!, 'settled-b')

    expect(emitSessionStartTwice(ctx)).toHaveLength(0)
  }, 30_000)
})
