import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as commandStatus from '@dsh-cc/command-status'
import { formatStatus, lastModel } from '@dsh-cc/command-status/status'

function ev(type: string, data: unknown, seq: number): SessionEvent {
  return Object.freeze({ seq, time: seq * 10, type, data }) as SessionEvent
}

function header(seq: number, provider: string, model: string): SessionEvent {
  return ev('request/header', { header: { config: { provider, model } }, reason: 'initial' }, seq)
}

describe('@dsh-cc/command-status registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    expect(commandStatus.name).toBe('command-status')
    expect(commandStatus.inject).toEqual(['commands'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandStatus)).toBe(commandStatus)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    const plugin = await ctx.plugin(commandStatus)
    const session = ctx.sessions.create(SessionId(`command-status-${Math.random()}`))
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
    expect(ctx.commands.find(agent, 'status')).toBeDefined()
    await plugin.dispose()
    expect(ctx.commands.find(agent, 'status')).toBeUndefined()
  })
})

describe('/status fold', () => {
  it('returns the model of the most recent request header', () => {
    const events = [header(1, 'deepseek', 'deepseek-chat'), header(2, 'deepseek', 'deepseek-reasoner')]
    expect(lastModel(events)).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
  })
  it('returns undefined when no request header was logged', () => {
    expect(lastModel([ev('turn/start', { turn: 0 }, 1)])).toBeUndefined()
  })
})

describe('/status formatting snapshot', () => {
  it('omits absent optional lines and keeps the always-present ones', () => {
    const text = formatStatus({ sessionId: 'abc', cwd: '/work', model: 'p/m', preset: 'strict' })
    expect(text).toEqual([
      'Model: p/m',
      'Permission preset: strict',
      'Session: abc',
      'Directory: /work',
    ].join('\n'))
  })
  it('renders only the session and directory lines when model and preset are absent', () => {
    expect(formatStatus({ sessionId: 'abc', cwd: '/work' }))
      .toBe('Session: abc\nDirectory: /work')
  })
  it('appends extra informational lines after the base fields', () => {
    const text = formatStatus({ sessionId: 'abc', cwd: '/work', extra: ['Hooks: none'] })
    expect(text).toBe('Session: abc\nDirectory: /work\nHooks: none')
  })
})

describe('/status human command', () => {
  it('reports the session id and directory on an empty session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(commandStatus)
    const session = ctx.sessions.create(SessionId('session-status'))
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
    const execution = await ctx.commands.execute(agent, '/status', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('Session: session-status')
    expect(text).toContain('Directory:')
    expect(text).not.toContain('Model:')
    expect(text).not.toContain('Permission preset:')
  })
})
