import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as commandRename from '@dsh-cc/command-rename'

type RenameFn = (session: unknown, title: string) => { title: string }

describe('/rename human command', () => {
  async function harness(seam?: { rename: RenameFn }) {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    if (seam) ctx.provide('sessionTitle', seam)
    await ctx.plugin(commandRename)
    const session = ctx.sessions.create(SessionId(`command-rename-human-${Math.random()}`))
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

  it('registers one global command with Loader-safe exports', async () => {
    expect(commandRename.name).toBe('command-rename')
    expect(commandRename.inject).toEqual(['commands'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandRename)).toBe(commandRename)
    const { ctx, agent } = await harness()
    expect(ctx.commands.find(agent, 'rename')).toBeDefined()
  })

  it('reports the seam when no session-title service is mounted', async () => {
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/rename New Title', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('error')
    expect((execution?.result as { text: string }).text).toMatch(/unavailable/)
  })

  it('rejects an empty argument without calling rename', async () => {
    const rename = vi.fn((session: unknown, title: string): { title: string } => ({ title: title.trim() }))
    const { ctx, agent } = await harness({ rename })
    const execution = await ctx.commands.execute(agent, '/rename', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('error')
    expect((execution?.result as { text: string }).text).toMatch(/Usage/)
    expect(rename).not.toHaveBeenCalled()
  })

  it('renames through the seam with the trimmed argument', async () => {
    const rename = vi.fn((session: unknown, title: string): { title: string } => ({ title: title.trim() }))
    const { ctx, agent } = await harness({ rename })
    // rawInput is verbatim after the command token; the handler trims it.
    const execution = await ctx.commands.execute(agent, '/rename   New Title  ', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    expect((execution?.result as { text: string }).text).toBe('Renamed to: New Title')
    expect(rename).toHaveBeenCalledWith(expect.anything(), 'New Title')
    expect(rename.mock.calls[0]?.[0]).toBe(agent.session)
  })

  it('passes rename validation failures through as errors', async () => {
    const rename = vi.fn(() => {
      throw new Error('session title must contain visible characters')
    })
    const { ctx, agent } = await harness({ rename })
    const execution = await ctx.commands.execute(agent, '/rename ???', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('error')
    expect((execution?.result as { text: string }).text).toBe('session title must contain visible characters')
  })
})
