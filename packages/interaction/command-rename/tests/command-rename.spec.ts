import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { titleSidecarPath } from '@dsh-cc/memory'
import * as commandRename from '@dsh-cc/command-rename'

/**
 * `defaultDshHome()` reads `os.homedir()` and has no env override, so the
 * sidecar home is redirected by mocking `os.homedir()` (the real one stays as
 * fallback for tests that do not set `sidecarHome.root`).
 */
const sidecarHome = vi.hoisted(() => ({ root: undefined as string | undefined }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => sidecarHome.root ?? actual.homedir() }
})

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

  it('writes a title sidecar carrying the accepted title', async () => {
    sidecarHome.root = mkdtempSync(join(tmpdir(), 'command-rename-'))
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(CommandRuntime)
      await ctx.plugin(AgentRegistry)
      ctx.provide('sessionTitle', {
        rename: (): { title: string } => ({ title: 'Accepted Title' }),
      })
      await ctx.plugin(commandRename)
      const cwd = join(sidecarHome.root, 'workspace')
      const session = ctx.sessions.create(SessionId('command-rename-sidecar'), { meta: { cwd } })
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

      const execution = await ctx.commands.execute(agent, '/rename Whatever I Typed', [], new AbortController().signal)
      expect(execution?.result.kind).toBe('success')
      // The sidecar carries the ACCEPTED title, not the raw invocation input.
      expect(readFileSync(titleSidecarPath(cwd, String(session.id)), 'utf8')).toBe('Accepted Title')
    } finally {
      sidecarHome.root = undefined
    }
  })
})


describe('/rename trailing help request', () => {
  it('answers `/rename help` with the rendered usage text, not a model turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(commandRename)
  const session = ctx.sessions.create(SessionId(`rename-${Math.random()}`))
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
    const execution = await ctx.commands.execute(agent, '/rename help', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('/rename')
    expect(text).toContain('Usage:')
  })
})
