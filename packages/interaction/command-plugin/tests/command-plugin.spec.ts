import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as commandPlugin from '@dsh-cc/command-plugin'
import {
  formatPluginList,
  formatReloadSummary,
  type CcPluginSummary,
  type CcComponentResult,
} from '@dsh-cc/command-plugin/plugin'

describe('@dsh-cc/command-plugin registration', () => {
  it('registers two global commands with Loader-safe exports and disposes them', async () => {
    expect(commandPlugin.name).toBe('command-plugin')
    expect(commandPlugin.inject).toEqual(['commands'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandPlugin)).toBe(commandPlugin)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    const plugin = await ctx.plugin(commandPlugin)
    const session = ctx.sessions.create(SessionId(`command-plugin-${Math.random()}`))
    const agent: Agent = {
      id: session.id,
      options: {},
      session,
      inbox: null as never,
      ctx: new Context(),
      get status(): 'idle' { return 'idle' },
      send: () => {},
      followup: () => {},
      steer: () => {},
      inject: () => {},
      cancel: () => {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(agent)
    expect(ctx.commands.find(agent, 'plugin')).toBeDefined()
    expect(ctx.commands.find(agent, 'reload-plugins')).toBeDefined()
    await plugin.dispose()
    expect(ctx.commands.find(agent, 'plugin')).toBeUndefined()
    expect(ctx.commands.find(agent, 'reload-plugins')).toBeUndefined()
  })
})

describe('/plugin rendering (pure)', () => {
  const components: readonly CcComponentResult[] = [
    { kind: 'commands', loaded: 2, skipped: 0, failed: 0 },
    { kind: 'skills', loaded: 1, skipped: 1, failed: 1 },
  ]
  it('renders component tallies, annotating skipped/failed when non-trivial', () => {
    // trivial components carry no suffix
    expect(
      formatPluginList([
        { name: 'p', root: '/r', components: [{ kind: 'commands', loaded: 2, skipped: 0, failed: 0 }] },
      ]),
    ).toContain('components: commands: 2')
    void components
  })
  it('lists each plugin name, root, and component counts', () => {
    const summary: CcPluginSummary = { name: 'cc-a', root: '/roots/a', components }
    const text = formatPluginList([summary])
    expect(text).toContain('- cc-a')
    expect(text).toContain('root: /roots/a')
    expect(text).toContain('commands: 2')
    expect(text).toContain('skills: 1 (1 skipped, 1 failed)')
  })
  it('reports an empty mount set gracefully', () => {
    expect(formatPluginList([])).toContain('No Claude Code plugins are mounted.')
  })
})

describe('/reload-plugins rendering (pure)', () => {
  it('summarizes a successful remount', () => {
    const text = formatReloadSummary(
      [{ name: 'cc-a', root: '/r/a', components: [] }],
      [],
    )
    expect(text).toContain('Reloaded 1 Claude Code plugin.')
    expect(text).toContain('- cc-a (/r/a)')
  })
  it('reports per-root remount errors', () => {
    const text = formatReloadSummary([], [{ root: '/r/a', name: 'cc-a', error: 'boom' }])
    expect(text).toContain('Reloaded 0 Claude Code plugins.')
    expect(text).toContain('cc-a (/r/a): boom')
  })
})

describe('/plugin and /reload-plugins human commands', () => {
  async function harness(seam?: { list(): CcPluginSummary[]; rescan(): Promise<{ root: string; name?: string; error: string }[]> }) {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(commandPlugin)
    if (seam) ctx.provide('ccPlugins', seam)
    const session = ctx.sessions.create(SessionId(`command-plugin-human-${Math.random()}`))
    const agent: Agent = {
      id: session.id,
      options: {},
      session,
      inbox: null as never,
      ctx: new Context(),
      get status(): 'idle' { return 'idle' },
      send: () => {},
      followup: () => {},
      steer: () => {},
      inject: () => {},
      cancel: () => {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(agent)
    return { ctx, agent }
  }

  it('degrades gracefully when the ccPlugins seam is absent', async () => {
    const { ctx, agent } = await harness()
    for (const path of ['/plugin', '/reload-plugins']) {
      const execution = await ctx.commands.execute(agent, path, [], new AbortController().signal)
      expect(execution?.result.kind).toBe('success')
      expect((execution?.result as { text: string }).text).toContain('cc-shell-glue absent')
    }
  })

  it('lists mounted plugins through the seam', async () => {
    const list = vi.fn(() => [
      { name: 'cc-a', root: '/r/a', components: [{ kind: 'commands', loaded: 2, skipped: 0, failed: 0 }] },
    ])
    const { ctx, agent } = await harness({ list, rescan: async () => [] })
    const execution = await ctx.commands.execute(agent, '/plugin', [], new AbortController().signal)
    expect(list).toHaveBeenCalled()
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('- cc-a')
    expect(text).toContain('commands: 2')
  })

  it('rescans through the seam and reports errors', async () => {
    const list = vi.fn(() => [])
    const rescan = vi.fn(async () => [{ root: '/r/b', name: 'cc-b', error: 'mount failed' }])
    const { ctx, agent } = await harness({ list, rescan })
    const execution = await ctx.commands.execute(agent, '/reload-plugins', [], new AbortController().signal)
    expect(rescan).toHaveBeenCalled()
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('cc-b (/r/b): mount failed')
  })
})


describe('/reload-plugins trailing help request', () => {
  it('answers `/reload-plugins help` with the rendered usage text, not a model turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(commandPlugin)
  const session = ctx.sessions.create(SessionId(`reload-plugins-${Math.random()}`))
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: null as never,
    ctx: new Context(),
    get status(): 'idle' { return 'idle' },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(agent)
  return agent
    const execution = await ctx.commands.execute(agent, '/reload-plugins help', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('/reload-plugins')
    expect(text).toContain('Usage:')
  })
})
