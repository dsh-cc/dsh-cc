import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as commandReleaseNotes from '@dsh-cc/command-release-notes'
import { CHANGELOG, renderReleaseNotes } from '@dsh-cc/command-release-notes/release-notes'

async function harness(): Promise<{
  ctx: Context
  agent: Agent
  plugin: Awaited<ReturnType<Context['plugin']>>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  const plugin = await ctx.plugin(commandReleaseNotes)
  const session = ctx.sessions.create(SessionId(`command-release-notes-${Math.random()}`))
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

describe('@dsh-cc/command-release-notes registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    expect(commandReleaseNotes.name).toBe('command-release-notes')
    expect(commandReleaseNotes.inject).toEqual(['commands'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandReleaseNotes)).toBe(commandReleaseNotes)
    const { ctx, agent, plugin } = await harness()
    expect(ctx.commands.find(agent, 'release-notes')).toBeDefined()
    await plugin.dispose()
    expect(ctx.commands.find(agent, 'release-notes')).toBeUndefined()
  })
})

describe('/release-notes content', () => {
  it('embeds a seeded changelog with the version section', () => {
    expect(CHANGELOG).toContain('# Release notes')
    expect(CHANGELOG).toContain('Permissions durability')
    expect(CHANGELOG).toContain('Commands')
  })
  it('renders a bounded prefix of lines', () => {
    const short = renderReleaseNotes(CHANGELOG, 4)
    expect(short.split('\n')).toHaveLength(4)
    expect(short.startsWith('# Release notes')).toBe(true)
  })
  it('renders the full changelog when no limit is requested', () => {
    expect(renderReleaseNotes(CHANGELOG)).toBe(CHANGELOG.replace(/\r\n/gu, '\n'))
  })
})

describe('/release-notes human command', () => {
  it('prints the bundled release notes', async () => {
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/release-notes', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('# Release notes')
    expect(text).toContain('0.1.0-rc.5')
  })
  it('honors a line-count argument and ignores an invalid one', async () => {
    const { ctx, agent } = await harness()
    const short = await ctx.commands.execute(agent, '/release-notes 3', [], new AbortController().signal)
    expect((short?.result as { text: string }).text.split('\n')).toHaveLength(3)
    const full = await ctx.commands.execute(agent, '/release-notes bogus', [], new AbortController().signal)
    expect((full?.result as { text: string }).text).toContain('0.1.0-rc.5')
  })
})
