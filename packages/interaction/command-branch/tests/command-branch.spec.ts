import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as commandBranch from '@dsh-cc/command-branch'
import { formatBranchError, formatBranchSuccess } from '@dsh-cc/command-branch/branch'

/** A minimal agent whose session is whatever object we pass. */
function fakeAgent(session: { id: SessionId }): Agent {
  return {
    id: session.id,
    options: {},
    session: session as unknown as Agent['session'],
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
}

describe('@dsh-cc/command-branch rendering (pure)', () => {
  it('renders a success report with the child id and entry instructions', () => {
    const text = formatBranchSuccess('child-1', '')
    expect(text).toContain('Forked new session: child-1')
    expect(text).toContain('dsh --resume child-1')
  })
  it('renders a noted success report', () => {
    expect(formatBranchSuccess('child-1', 'refactor-core')).toContain('Branch "refactor-core" forked: child-1')
  })
  it('renders a friendly failure report', () => {
    expect(formatBranchError('SESSION_ALREADY_EXISTS')).toContain('Could not fork the current session')
  })
})

describe('/branch human command', () => {
  it('registers one global command with Loader-safe exports', async () => {
    expect(commandBranch.name).toBe('command-branch')
    expect(commandBranch.inject).toEqual(['commands'])
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(commandBranch)
    const session = Session.create(SessionId(`command-branch-reg-${Math.random()}`))
    const agent = fakeAgent(session)
    ctx.agents.register(agent)
    expect(ctx.commands.find(agent, 'branch')).toBeDefined()
  })

  it('degrades gracefully when no session store is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(commandBranch)
    const agent = fakeAgent(Session.create(SessionId(`command-branch-nostore-${Math.random()}`)))
    ctx.agents.register(agent)
    const execution = await ctx.commands.execute(agent, '/branch', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    expect((execution?.result as { text: string }).text).toContain('No session store is mounted')
  })

  it('forks the current session and reports the child id', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(commandBranch)
    const parent = ctx.sessions.create(SessionId(`command-branch-${Math.random()}`))
    const agent = fakeAgent(parent)
    ctx.agents.register(agent)
    const before = ctx.sessions.get(parent.id)
    expect(before).toBeDefined()
    const execution = await ctx.commands.execute(agent, '/branch', [], new AbortController().signal)
    const text = (execution?.result as { text: string }).text
    const match = /Forked new session: (.*)/u.exec(text)
    expect(match).toBeTruthy()
    const childId = match![1]
    expect(childId).not.toBe(parent.id)
    expect(ctx.sessions.get(childId)).toBeDefined()
    expect(text).toContain(`dsh --resume ${childId}`)
  })

  it('forks with an optional note rendered back', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(commandBranch)
    const parent = ctx.sessions.create(SessionId(`command-branch-${Math.random()}`))
    const agent = fakeAgent(parent)
    ctx.agents.register(agent)
    const execution = await ctx.commands.execute(agent, '/branch refactor-core', [], new AbortController().signal)
    expect((execution?.result as { text: string }).text).toContain('Branch "refactor-core" forked')
  })

  it('reports a fork failure as a friendly error', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(commandBranch)
    // A session object that is not the store's live instance → SESSION_NOT_LIVE.
    const foreign = Session.create(SessionId(`command-branch-foreign-${Math.random()}`))
    const agent = fakeAgent(foreign)
    ctx.agents.register(agent)
    const execution = await ctx.commands.execute(agent, '/branch', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    expect((execution?.result as { text: string }).text).toContain('Could not fork the current session')
  })
})
