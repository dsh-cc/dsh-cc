/**
 * Unit tests for the plugin MCP seam (`createPluginMcpSeam`): the bridge that
 * turns a CC plugin's inline `mcpServers` entries into mcp-client instances.
 * The mcp-client plugin is faked to a config-capturing stub (D9) and the env
 * lookup is injected, so every pipeline behavior of `buildRegistrations`
 * (normalization, `${VAR}` / `${VAR:-default}` expansion, throw-on-unset,
 * malformed-entry validation) is observable at the seam boundary, plus the
 * dispose-settle pending-release ledger (D8) and the deferred-attach
 * cancellation protocol.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import { apply } from '../src/index.ts'
import { createPluginMcpSeam } from '../src/mcpSeam.ts'

/** Drain the microtask/macrotask queue so chained attaches fire. */
async function settle(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>(resolve => setImmediate(resolve))
}

/** One fake mcp-client instance: the config it received and its dispose count. */
interface FakeEntry {
  config: Record<string, unknown>
  disposeCount: number
}

interface FakeOptions {
  /** Hold activation open (the apply promise does not settle until released). */
  gate?: PromiseWithResolvers<void>
  /** Make activation reject with this error. */
  failWith?: Error
  /** Make the instance's teardown (effect cleanup) throw with this error. */
  teardownError?: Error
}

/** A config-capturing fake of the mcp-client namespace plugin (D9). */
function createFakeClient(options: FakeOptions = {}): { plugin: object; entries: FakeEntry[] } {
  const entries: FakeEntry[] = []
  const plugin = {
    name: 'fake-mcp-client',
    apply(c: Context, config: Record<string, unknown>) {
      const entry: FakeEntry = { config, disposeCount: 0 }
      entries.push(entry)
      c.fiber.effect(() => () => {
        entry.disposeCount++
        if (options.teardownError !== undefined) throw options.teardownError
      })
      if (options.failWith !== undefined) return Promise.reject(options.failWith)
      return options.gate?.promise
    },
  }
  return { plugin, entries }
}

/** A stdio server entry valid enough for buildRegistrations to accept. */
function validEntry(): Record<string, unknown> {
  return { type: 'stdio', command: 'some-command', args: ['--flag'] }
}

let ctx: Context
let warns: string[]

beforeEach(() => {
  ctx = new Context()
  warns = []
  ctx.logger.warn = (message: unknown, ...rest: unknown[]) => {
    warns.push([message, ...rest].map(String).join(' '))
  }
})

afterEach(async () => {
  await ctx.fiber.dispose()
})

describe('cc-shell plugin MCP seam — registration pipeline', () => {
  it('1. valid stdio entry → fake client receives normalized+deferred config', async () => {
    const fake = createFakeClient()
    const seam = createPluginMcpSeam(ctx, { plugin: fake.plugin })
    const dispose = seam.registerServer('me.server', validEntry())
    expect(typeof dispose).toBe('function')

    await settle()
    expect(fake.entries).toHaveLength(1)
    expect(fake.entries[0]!.config).toMatchObject({
      transport: 'stdio',
      command: 'some-command',
      args: ['--flag'],
      serverName: 'me-server', // normalized to the tool-prefix contract
      deferStartupConnect: true,
      failOnStartupError: false,
    })
  })

  it('2. ${VAR} and ${VAR:-default} expansion honor the injected env', async () => {
    const fake = createFakeClient()
    const seam = createPluginMcpSeam(ctx, {
      plugin: fake.plugin,
      env: { PRESENT: 'live', EMPTY_VAR: '' },
    })
    seam.registerServer('expand', {
      type: 'stdio',
      command: 'run ${PRESENT} ${ABSENT:-fallback} ${EMPTY_VAR:-was-empty}',
    })

    await settle()
    expect(fake.entries[0]!.config).toMatchObject({
      command: 'run live fallback was-empty',
    })
  })

  it('3. unset ${VAR} without default → warn names the variable; no instance; no-op disposer', async () => {
    const fake = createFakeClient()
    const seam = createPluginMcpSeam(ctx, { plugin: fake.plugin, env: {} })
    const dispose = seam.registerServer('skipped', {
      type: 'stdio',
      command: 'run ${DEFINITELY_UNSET_VAR}',
    })

    await settle()
    expect(warns.some(w => w.includes('DEFINITELY_UNSET_VAR') && w.includes('skipped'))).toBe(true)
    // No mcp-client instance (and therefore no mcpConnections entry) is fabricated.
    expect(fake.entries).toHaveLength(0)
    expect(() => dispose()).not.toThrow()
  })

  it('4. malformed entry (no command) → warn + skip, never throws', () => {
    const fake = createFakeClient()
    const seam = createPluginMcpSeam(ctx, { plugin: fake.plugin })
    expect(() => seam.registerServer('broken', { type: 'stdio' })).not.toThrow()
    expect(warns.some(w => w.includes('broken') && w.includes('command'))).toBe(true)
    expect(fake.entries).toHaveLength(0)
  })
})

describe('cc-shell plugin MCP seam — pending-release ledger (D8)', () => {
  it('5. duplicate name while activation pending → second attach chained behind settle; cancellation disposes the deferred fiber', async () => {
    // --- 5a: the second attach waits for the first fiber's settle. ---
    const gate = Promise.withResolvers<void>()
    const fake = createFakeClient({ gate })
    const seam = createPluginMcpSeam(ctx, { plugin: fake.plugin })
    const dispose1 = seam.registerServer('dup', validEntry())
    await settle()
    expect(fake.entries).toHaveLength(1) // first attached, activation pending

    const dispose2 = seam.registerServer('dup', validEntry())
    await settle()
    // Still chained behind the first fiber's settle — no second instance yet.
    expect(fake.entries).toHaveLength(1)

    gate.resolve()
    await settle()
    expect(fake.entries).toHaveLength(2)
    expect(dispose1).toBeTypeOf('function')
    expect(dispose2).toBeTypeOf('function')

    // --- 5b: activation rejection is logged, never unhandled. ---
    const failing = createFakeClient({ failWith: new Error('namespace taken') })
    const seam2 = createPluginMcpSeam(ctx, { plugin: failing.plugin })
    seam2.registerServer('rejecting', validEntry())
    await settle()
    expect(warns.some(w => w.includes('rejecting') && w.includes('namespace taken'))).toBe(true)
  })

  it('5b. disposing the second registration BEFORE its chained attach fires disposes the fresh fiber — no zombie', async () => {
    const gate = Promise.withResolvers<void>()
    const fake = createFakeClient({ gate })
    const seam = createPluginMcpSeam(ctx, { plugin: fake.plugin })
    const dispose1 = seam.registerServer('dup2', validEntry())
    await settle()
    expect(fake.entries).toHaveLength(1)

    const dispose2 = seam.registerServer('dup2', validEntry())
    await settle()
    expect(fake.entries).toHaveLength(1) // attach still chained

    dispose2() // cancel before the chained attach fires
    gate.resolve()
    await settle(20)
    // The cancelled deferred attach mounted a fiber whose disposal was
    // requested while still PENDING — cordis never even runs its apply, so
    // no second (zombie) instance ever exists.
    expect(fake.entries).toHaveLength(1)
    void dispose1
  })

  it('6. disposer before activation settles → fiber disposed; teardown rejection caught; re-register chains behind dispose-settle', async () => {
    // --- 6a: dispose while activation pending. ---
    const gate = Promise.withResolvers<void>()
    const fake = createFakeClient({ gate })
    const seam = createPluginMcpSeam(ctx, { plugin: fake.plugin })
    const dispose = seam.registerServer('early', validEntry())
    await settle()
    expect(fake.entries).toHaveLength(1)

    dispose() // before the gate releases
    gate.resolve()
    await settle()
    expect(fake.entries[0]!.disposeCount).toBe(1)

    // --- 6b: a teardown failure never escapes the disposer (no throw, no
    //     unhandled rejection). Vendored cordis _unload catches effect
    //     teardown errors itself and logs them via logger.error (the fiber
    //     dispose promise never rejects), so the observable surface is
    //     logger.error; the seam additionally .catch-warns its dispose
    //     chain for any rejection that does propagate. ---
    const errors: string[] = []
    const realError = ctx.logger.error.bind(ctx.logger)
    ctx.logger.error = (message: unknown, ...rest: unknown[]) => {
      errors.push([message, ...rest].map(String).join(' '))
    }
    const leaky = createFakeClient({ teardownError: new Error('teardown boom') })
    const seam2 = createPluginMcpSeam(ctx, { plugin: leaky.plugin })
    const disposeLeaky = seam2.registerServer('leaky', validEntry())
    await settle()
    expect(() => disposeLeaky()).not.toThrow()
    await settle()
    expect(errors.some(w => w.includes('teardown boom'))).toBe(true)
    ctx.logger.error = realError

    // --- 6c: re-register AFTER a dispose chains behind the dispose-settle
    //     promise (D8), not behind activation-settle (which long settled). ---
    const plain = createFakeClient()
    const seam3 = createPluginMcpSeam(ctx, { plugin: plain.plugin })
    const first = seam3.registerServer('remount', validEntry())
    await settle()
    expect(plain.entries).toHaveLength(1)

    first() // dispose — the dispose-settle promise is still pending
    const second = seam3.registerServer('remount', validEntry())
    // No microtask has run: the dispose-settle chain holds the attach back.
    expect(plain.entries).toHaveLength(1)

    await settle()
    expect(plain.entries).toHaveLength(2)
    expect(plain.entries[1]!.disposeCount).toBe(0)
    void second
  })

  it('7. onRegistered is called with the normalized server name', async () => {
    const fake = createFakeClient()
    const registered: string[] = []
    const seam = createPluginMcpSeam(ctx, { plugin: fake.plugin, onRegistered: n => registered.push(n) })
    seam.registerServer('me.server', validEntry())
    expect(registered).toEqual(['me-server'])
  })
})

/**
 * S4 wiring regression: the glue composition provides the `mcp` seam via the
 * child-plugin idiom BEFORE `CcPluginsService.mountAll`, so a mounted CC
 * plugin's `mcpServers` tally is `loaded` (not skipped) — this pins the
 * strict-get ACTIVE-fiber visibility rule a direct provide would violate —
 * and the plugin's server names feed the boot deferred-notice list.
 */
describe('cc-shell glue wiring — plugin MCP seam', () => {
  let bootCtx: Context
  let tmp: string
  let previous: Record<'DSH_HOME' | 'CLAUDE_CONFIG_DIR' | 'HOME', string | undefined>

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cc-shell-mcp-seam-'))
    previous = {
      DSH_HOME: process.env.DSH_HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      HOME: process.env.HOME,
    }
    // Isolate the discovery roots so the real user config never leaks in.
    mkdirSync(join(tmp, 'dsh'), { recursive: true })
    mkdirSync(join(tmp, 'claude'), { recursive: true })
    mkdirSync(join(tmp, 'home'), { recursive: true })
    process.env.DSH_HOME = join(tmp, 'dsh')
    process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude')
    process.env.HOME = join(tmp, 'home')
  })

  afterEach(async () => {
    for (const key of ['DSH_HOME', 'CLAUDE_CONFIG_DIR', 'HOME'] as const) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    await bootCtx.fiber.dispose()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('boot composition: probe plugin with inline mcpServers sees ctx.get("mcp"), mounts loaded, and feeds the deferred notice', async () => {
    // A fixture server whose initialize reply is delayed far beyond the test
    // window, so the server stays `connecting` when the one-shot notice fires.
    const slowServer = join(tmp, 'slow-server.mjs')
    writeFileSync(slowServer, `
import { createInterface } from 'node:readline'
const respond = (id, result) => {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}
createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.id === undefined || message.id === null) return
  if (message.method === 'initialize') {
    setTimeout(() => respond(message.id, {
      protocolVersion: '2025-03-26',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'slow', version: '1.0.0' },
    }), 60_000)
  }
})
`, 'utf8')

    // Probe CC plugin declaring an inline mcpServers entry.
    const pluginRoot = join(tmp, 'probe-plugin')
    mkdirSync(pluginRoot, { recursive: true })
    writeFileSync(join(pluginRoot, 'plugin.json'), JSON.stringify({
      name: 'probe',
      version: '0.1.0',
      mcpServers: {
        probe: { type: 'stdio', command: process.execPath, args: [slowServer] },
      },
    }), 'utf8')

    bootCtx = new Context()
    await bootCtx.plugin(SystemPrompt)
    await bootCtx.plugin(ToolRuntime)

    await apply(bootCtx, { pluginDirs: [pluginRoot] })

    // The seam is visible on the composition context…
    expect(bootCtx.get('mcp')).toBeDefined()
    // …and the mounted CC plugin's mcpServers tally is `loaded` (the loader
    // probes ctx.get('mcp') from its mount fiber — a direct provide on the
    // LOADING glue fiber would have made this `skipped`).
    const summary = bootCtx.ccPlugins.list().find(entry => entry.name === 'probe')
    expect(summary).toBeDefined()
    const mcpTally = summary!.components.find(c => c.kind === 'mcpServers')
    expect(mcpTally).toMatchObject({ kind: 'mcpServers', loaded: 1, skipped: 0 })

    // The plugin server is registered (deferred) and still connecting —
    // fire the one-shot session-start notice and check the deferred-names
    // feed carries the plugin server.
    const registry = bootCtx.get('mcpConnections') as { entries(): { name: string; state: string }[] }
    expect(registry.entries().find(e => e.name === 'probe')?.state).toBe('connecting')

    const captured: unknown[] = []
    const agent = { inject: (message: unknown) => captured.push(message) }
    bootCtx.emit(bootCtx, 'agent/session-start', { agent, source: 'startup' })
    const texts = captured
      .map((m: { content?: Array<{ text?: string }> }) => (m.content ?? []).map(p => p.text ?? '').join(''))
      .join('\n')
    expect(texts).toContain('probe')
  })
})
