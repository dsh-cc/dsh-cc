/**
 * Tests for the cc-shell plugin-mount registry (`CcPluginsService`): every
 * mount is tracked in `list()`, `rescan()` re-runs discovery and picks up newly
 * added plugins, and dispose is symmetric (a rescan fully recalls the prior
 * mount's component disposers before re-mounting). Uses a real Context with a
 * minimal hand-written Claude Code plugin in a temp dir, mirroring the harness
 * style of command-status.spec.ts.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config as GlueConfig, type Config } from '@dsh-cc/bundle-shell/src/index.ts'
import { CcPluginsService } from '@dsh-cc/bundle-shell/src/ccPlugins.ts'

/** A commands seam that tracks live (undisposed) command names. */
function createCommandsSeam(): { register: (d: { name: string }) => () => void; live: () => string[] } {
  const active = new Set<string>()
  return {
    register: (definition) => {
      active.add(definition.name)
      return () => { active.delete(definition.name) }
    },
    live: () => Array.from(active),
  }
}

/** Write a minimal CC plugin root (plugin.json + one inline command). */
function writePlugin(root: string, name: string, commandName: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    name,
    version: '0.1.0',
    commands: {
      [commandName]: { description: `command from ${name}`, content: `# ${name}\n\nhello` },
    },
  }, null, 2))
}

let ctx: Context
let tmpRoot: string
let commands: ReturnType<typeof createCommandsSeam>

function configFor(dirs: string[]): Config {
  return { pluginDirs: dirs }
}

beforeEach(() => {
  ctx = new Context()
  commands = createCommandsSeam()
  ctx.provide('commands', commands)
  tmpRoot = mkdtempSync(join(tmpdir(), 'cc-shell-plugins-'))
})

afterEach(async () => {
  await ctx.fiber.dispose()
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('@dsh-cc/bundle-shell ccPlugins registry', () => {
  it('tracks the initially mounted plugin in list()', async () => {
    const dir = join(tmpRoot, 'alpha')
    writePlugin(dir, 'alpha', 'alpha-command')

    await apply(ctx, configFor([tmpRoot]))

    expect(ctx.ccPlugins.list()).toHaveLength(1)
    expect(ctx.ccPlugins.list()[0]).toMatchObject({ name: 'alpha', root: dir })
    // The commands seam received the plugin's command.
    expect(commands.live()).toContain('alpha-command')
  })

  it('rescan picks up a newly added plugin dir', async () => {
    const alpha = join(tmpRoot, 'alpha')
    writePlugin(alpha, 'alpha', 'alpha-command')

    await apply(ctx, configFor([tmpRoot]))
    expect(ctx.ccPlugins.list()).toHaveLength(1)

    // Add a second plugin on disk, then rescan.
    const beta = join(tmpRoot, 'beta')
    writePlugin(beta, 'beta', 'beta-command')
    const errors = await ctx.ccPlugins.rescan()

    expect(errors).toEqual([])
    const names = ctx.ccPlugins.list().map(entry => entry.name).sort()
    expect(names).toEqual(['alpha', 'beta'])
    expect(commands.live()).toContain('alpha-command')
    expect(commands.live()).toContain('beta-command')
  })

  it('dispose is symmetric: rescan recalls the prior mount before re-mounting', async () => {
    writePlugin(join(tmpRoot, 'alpha'), 'alpha', 'alpha-command')

    await apply(ctx, configFor([tmpRoot]))
    expect(ctx.ccPlugins.list()).toHaveLength(1)
    expect(commands.live()).toContain('alpha-command')

    // Rescan with the same plugin still on disk: the old mount's disposer ran,
    // then the plugin was re-mounted exactly once (no leaked registrations).
    const errors = await ctx.ccPlugins.rescan()
    expect(errors).toEqual([])
    expect(ctx.ccPlugins.list()).toHaveLength(1)
    expect(commands.live().filter(name => name === 'alpha-command')).toHaveLength(1)
  })

  it('default discovery (absent pluginDirs) mounts installed ∩ enabled plugins', async () => {
    const home = join(tmpRoot, 'claude-home')
    const cwd = join(tmpRoot, 'workspace')
    const install = join(home, 'plugins', 'cache', 'official', 'alpha', '1.0.0')
    writePlugin(install, 'alpha', 'alpha-command')
    mkdirSync(join(home), { recursive: true })
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
      enabledPlugins: { 'alpha@official': true },
    }))
    writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: { 'alpha@official': [{ scope: 'user', installPath: install }] },
    }))

    const service = new CcPluginsService(ctx, { claudeHome: home, cwd })
    const errors = await service.mountAll()
    expect(errors).toEqual([])
    expect(service.list()).toHaveLength(1)
    expect(service.list()[0]).toMatchObject({ name: 'alpha', root: install })
    expect(commands.live()).toContain('alpha-command')
  })

  it('rescan re-reads the enabled/installed cascade', async () => {
    const home = join(tmpRoot, 'claude-home')
    const cwd = join(tmpRoot, 'workspace')
    const alpha = join(home, 'plugins', 'cache', 'official', 'alpha', '1.0.0')
    const beta = join(home, 'plugins', 'cache', 'official', 'beta', '1.0.0')
    writePlugin(alpha, 'alpha', 'alpha-command')
    mkdirSync(join(home, 'plugins'), { recursive: true })
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
      enabledPlugins: { 'alpha@official': true },
    }))
    writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: { 'alpha@official': [{ scope: 'user', installPath: alpha }] },
    }))

    const service = new CcPluginsService(ctx, { claudeHome: home, cwd })
    await service.mountAll()
    expect(service.list().map(entry => entry.name)).toEqual(['alpha'])

    writePlugin(beta, 'beta', 'beta-command')
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
      enabledPlugins: { 'alpha@official': true, 'beta@official': true },
    }))
    writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'alpha@official': [{ scope: 'user', installPath: alpha }],
        'beta@official': [{ scope: 'user', installPath: beta }],
      },
    }))
    const errors = await service.rescan()
    expect(errors).toEqual([])
    expect(service.list().map(entry => entry.name).sort()).toEqual(['alpha', 'beta'])
  })

  it('keeps pluginDirs undefined when Config is empty so default discovery fires', () => {
    expect(GlueConfig({}).pluginDirs).toBeUndefined()
  })
})

describe('@dsh-cc/bundle-shell plugin command channel', () => {
  it('lists plugin commands with colon display names, including plugin == command as x:x', async () => {
    const plain = join(tmpRoot, 'alpha')
    writePlugin(plain, 'alpha', 'alpha-command')
    const same = join(tmpRoot, 'x')
    writePlugin(same, 'x', 'x')

    await apply(ctx, configFor([tmpRoot]))

    const names = ctx.ccPlugins.listPluginCommands().map(info => info.name).sort()
    expect(names).toEqual(['alpha:alpha-command', 'x:x'])
    const alpha = ctx.ccPlugins.listPluginCommands().find(info => info.plugin === 'alpha')
    expect(alpha).toMatchObject({ plugin: 'alpha', description: 'command from alpha' })
  })

  it('runPluginCommand renders $ARGUMENTS and dispatches a user-prompt followup', async () => {
    const dir = join(tmpRoot, 'alpha')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({
      name: 'alpha',
      commands: { rescue: { description: 'rescue it', content: 'Fix $ARGUMENTS now' } },
    }))
    await apply(ctx, configFor([tmpRoot]))

    const sent: unknown[] = []
    const result = await ctx.ccPlugins.runPluginCommand('alpha:rescue', {
      agent: { followup: (message: unknown) => { sent.push(message); return undefined } },
      rawInput: 'the flaky test',
    })
    expect(result).toEqual({ ok: true })
    expect(sent).toHaveLength(1)
    const message = sent[0] as { content?: Array<{ text?: string }>; source?: { kind?: string } }
    expect(message.content?.map(part => part.text ?? '').join('')).toBe('Fix the flaky test now')
    expect(message.source?.kind).toBe('user')
  })

  it('runPluginCommand folds a failed dispatch into { ok: false, reason }', async () => {
    writePlugin(join(tmpRoot, 'alpha'), 'alpha', 'alpha-command')
    await apply(ctx, configFor([tmpRoot]))
    const info = ctx.ccPlugins.listPluginCommands()[0]!
    const result = await ctx.ccPlugins.runPluginCommand(info.name, {
      agent: { followup: () => { throw new Error('agent busy') } },
      rawInput: '',
    })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('agent busy')
  })

  it('runPluginCommand returns { ok: false } for an unknown command name', async () => {
    writePlugin(join(tmpRoot, 'alpha'), 'alpha', 'alpha-command')
    await apply(ctx, configFor([tmpRoot]))
    const result = await ctx.ccPlugins.runPluginCommand('alpha:missing', {
      agent: { followup: () => undefined },
      rawInput: '',
    })
    expect(result).toMatchObject({ ok: false })
  })

  it('rescan clears and rebuilds the command table and fires ccPlugins/change', async () => {
    writePlugin(join(tmpRoot, 'alpha'), 'alpha', 'alpha-command')
    await apply(ctx, configFor([tmpRoot]))
    expect(ctx.ccPlugins.listPluginCommands().map(info => info.name)).toEqual(['alpha:alpha-command'])

    const changes: number[] = []
    ctx.on('ccPlugins/change' as Parameters<typeof ctx.on>[0], () => { changes.push(changes.length) })

    // Remove the plugin from disk, then rescan: the table drains to empty.
    rmSync(join(tmpRoot, 'alpha'), { recursive: true, force: true })
    await ctx.ccPlugins.rescan()
    expect(ctx.ccPlugins.listPluginCommands()).toEqual([])

    // Re-add it (with a second command) and rescan: the table rebuilds.
    writePlugin(join(tmpRoot, 'alpha'), 'alpha', 'alpha-command')
    await ctx.ccPlugins.rescan()
    const names = ctx.ccPlugins.listPluginCommands().map(info => info.name)
    expect(names).toEqual(['alpha:alpha-command'])
    // Two change events after the listener registered (the initial mountAll's
    // event fired before it): one per rescan.
    expect(changes).toHaveLength(2)
  })
})

/**
 * The topology the flat unit tests above miss: in the real composition the CC
 * preset mounts cc-shell-glue INSIDE the `cc-services` isolate realm while the
 * host-plane consumers (TUI driver, /help) sit in sibling plugin fibers that
 * resolve `ccPlugins` against the root realm. A realm-scoped Service.provide
 * is invisible across that boundary — this suite pins the cross-scope contract.
 */
describe('@dsh-cc/bundle-shell cross-scope visibility (real bundle topology)', () => {
  it('a sibling bundle fiber resolves ccPlugins, receives ccPlugins/change, and degrades after glue dispose', async () => {
    writePlugin(join(tmpRoot, 'alpha'), 'alpha', 'alpha-command')

    const root = new Context()
    // Host-plane seams the glue reads during mount; in the real composition
    // they are provided at the root realm (outside the cc-services group).
    root.provide('mcpConnections', {})
    root.provide('ccModelRoutes', undefined)
    root.provide('commands', commands)

    // The cc-services group realm: the preset isolates `ccPlugins` here and
    // mounts the glue inside it.
    const group = root.isolate('ccPlugins')

    // The consumer is a SEPARATE plugin fiber directly under root — a sibling
    // subtree of the group, like the TUI bundle's `tui` row or /help.
    let consumerCtx: Context | undefined
    const changes: number[] = []
    await root.plugin({
      name: 'host-consumer',
      apply(c: Context) {
        consumerCtx = c
        c.on('ccPlugins/change', () => { changes.push(changes.length) })
      },
    })

    const glue = group.plugin({ name: 'cc-shell-glue', apply }, configFor([tmpRoot]))
    await glue

    // Sibling visibility: the consumer's context resolves the registry even
    // though it was published from inside the isolated group realm.
    const resolved = consumerCtx!.get('ccPlugins') as CcPluginsService | undefined
    expect(resolved).toBeDefined()
    expect(resolved!.list().map(entry => entry.name)).toEqual(['alpha'])
    expect(resolved!.listPluginCommands().map(info => info.name)).toEqual(['alpha:alpha-command'])

    // Event reachability: mountAll's change event crossed the bundle boundary.
    expect(changes).toHaveLength(1)

    // Property-access path (command-help's `(ctx as ...).ccPlugins` read).
    expect((consumerCtx as { ccPlugins?: CcPluginsService }).ccPlugins).toBe(resolved)

    // Lifecycle: disposing the glue fiber removes the published property, and
    // the consumer degrades to undefined instead of holding a dead registry.
    await (await glue).dispose()
    expect(consumerCtx!.get('ccPlugins')).toBeUndefined()

    await root.fiber.dispose()
  })
})
