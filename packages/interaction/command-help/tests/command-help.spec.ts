import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as commandHelp from '@dsh-cc/command-help'
import { formatHelpDetail, formatHelpList } from '@dsh-cc/command-help/help'
import type { PluginCommandInfo } from '@dsh-cc/command-help'

const DESCRIPTORS: readonly CommandDescriptor[] = [
  Object.freeze({ name: 'memory', description: 'list memories' }),
  Object.freeze({ name: 'export', description: 'export a transcript', input: Object.freeze({ hint: '[json] [<path>]' }) }),
  Object.freeze({ name: 'help', description: 'show command help', input: Object.freeze({ hint: '[command]' }) }),
]

async function harness(): Promise<{
  ctx: Context
  agent: Agent
  plugin: Awaited<ReturnType<Context['plugin']>>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  const plugin = await ctx.plugin(commandHelp)
  const session = ctx.sessions.create(SessionId(`command-help-${Math.random()}`))
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
  return { ctx, agent, plugin }
}

describe('@dsh-cc/command-help registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    expect(commandHelp.name).toBe('command-help')
    expect(commandHelp.inject).toEqual(['commands'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandHelp)).toBe(commandHelp)
    const { ctx, agent, plugin } = await harness()
    expect(ctx.commands.find(agent, 'help')).toBeDefined()
    await plugin.dispose()
    expect(ctx.commands.find(agent, 'help')).toBeUndefined()
  })
})

describe('/help rendering', () => {
  it('renders a sorted index of name and description', () => {
    const text = formatHelpList(DESCRIPTORS)
    const lines = text.split('\n')
    // sorted by name: export, help, memory
    expect(lines[0]).toBe('/export — export a transcript')
    expect(lines[1]).toBe('/help — show command help')
    expect(lines[2]).toBe('/memory — list memories')
  })
  it('renders a command detail including its input hint', () => {
    const detail = formatHelpDetail(DESCRIPTORS, 'export')
    expect(detail).toContain('/export')
    expect(detail).toContain('usage: /export [json] [<path>]')
  })
  it('returns undefined for an unknown command', () => {
    expect(formatHelpDetail(DESCRIPTORS, 'nope')).toBeUndefined()
  })
})

describe('plugin commands via optional ccPlugins service', () => {
  const PLUGIN_COMMANDS: readonly PluginCommandInfo[] = [
    { name: 'codex:review', plugin: 'codex', description: 'review code with codex', argumentHint: '[path]' },
    { name: 'codex:rescue', plugin: 'codex', description: 'rescue a stuck session' },
  ]

  function fakeCcPlugins(commands: readonly PluginCommandInfo[] = PLUGIN_COMMANDS): unknown {
    return { listPluginCommands: () => commands }
  }

  it('merges plugin commands into the rendered list with a plugin marker', async () => {
    const { ctx, agent } = await harness()
    ;(ctx as Record<string, unknown>).ccPlugins = fakeCcPlugins()
    const execution = await ctx.commands.execute(agent, '/help', [], new AbortController().signal)
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('/codex:rescue — rescue a stuck session [plugin: codex]')
    expect(text).toContain('/codex:review — review code with codex [plugin: codex]')
    expect(text).toContain('/help — ')
  })

  it('skips a plugin command whose name collides with a harness command', () => {
    const text = formatHelpList(DESCRIPTORS, [
      ...PLUGIN_COMMANDS,
      { name: 'memory', plugin: 'codex', description: 'shady duplicate' },
    ])
    expect(text).toContain('/memory — list memories')
    expect(text).not.toContain('shady duplicate')
  })

  it('shows plugin command detail for a colon token and reports misses', async () => {
    const { ctx, agent } = await harness()
    ;(ctx as Record<string, unknown>).ccPlugins = fakeCcPlugins()
    const hit = await ctx.commands.execute(agent, '/help codex:review', [], new AbortController().signal)
    const hitText = (hit?.result as { text: string }).text
    expect(hitText).toContain('/codex:review')
    expect(hitText).toContain('review code with codex')
    expect(hitText).toContain('from plugin: codex')
    expect(hitText).toContain('usage: /codex:review [path]')
    const miss = await ctx.commands.execute(agent, '/help codex:nope', [], new AbortController().signal)
    expect((miss?.result as { text: string }).text).toContain('Unknown command /codex:nope')
  })

  it('behaves identically when the ccPlugins service is absent', async () => {
    const { ctx, agent } = await harness()
    const list = await ctx.commands.execute(agent, '/help', [], new AbortController().signal)
    const listText = (list?.result as { text: string }).text
    expect(listText).not.toContain('[plugin:')
    expect(listText).not.toContain('codex:')
    const miss = await ctx.commands.execute(agent, '/help codex:review', [], new AbortController().signal)
    expect((miss?.result as { text: string }).text).toContain('Unknown command /codex:review')
  })
})

describe('/help human command', () => {
  it('lists at least the help command itself', async () => {
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/help', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('/help — ')
  })

  it('appends the trailing-help-arg tip to the list output', async () => {
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/help', [], new AbortController().signal)
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('Tip: every command accepts a trailing `help` argument for usage details.')
  })
  it('shows detail for a named command and a friendly message for an unknown one', async () => {
    const { ctx, agent } = await harness()
    const detail = await ctx.commands.execute(agent, '/help help', [], new AbortController().signal)
    // `/help help` is now intercepted by helpable and answers with the
    // canonical formatted help text instead of the detail renderer.
    const detailText = (detail?.result as { text: string }).text
    expect(detailText).toContain('Usage:')
    expect(detailText).toContain('/help [command]')
    const missing = await ctx.commands.execute(agent, '/help nope', [], new AbortController().signal)
    expect((missing?.result as { text: string }).text).toContain('Unknown command /nope')
  })
})

describe('/help help interception', () => {
  it('answers a trailing help argument with formatted help text', async () => {
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/help help', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = execution?.result.text ?? ''
    expect(text).toContain('/help')
    expect(text).toContain('Usage:')
    expect(text).toContain('[command]')
    expect(text).toContain('trailing')
  })
})
