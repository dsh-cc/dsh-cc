import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import * as commandInit from '@dsh-cc/command-init'
import { INIT_PROMPT, initContent } from '@dsh-cc/command-init/init'

async function harness(): Promise<{
  ctx: Context
  agent: Agent
  plugin: Awaited<ReturnType<Context['plugin']>>
  followups: UserMessage[]
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  const followups: UserMessage[] = []
  const session = ctx.sessions.create(SessionId(`command-init-${Math.random()}`))
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: null as never,
    ctx: new Context(),
    get status(): 'idle' { return 'idle' },
    send: () => {},
    followup: (message: UserMessage) => { followups.push(message) },
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(agent)
  const plugin = await ctx.plugin(commandInit)
  return { ctx, agent, plugin, followups }
}

describe('@dsh-cc/command-init registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    expect(commandInit.name).toBe('command-init')
    expect(commandInit.inject).toEqual(['commands'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandInit)).toBe(commandInit)
    const { ctx, agent, plugin } = await harness()
    expect(ctx.commands.find(agent, 'init')).toBeDefined()
    await plugin.dispose()
    expect(ctx.commands.find(agent, 'init')).toBeUndefined()
  })
})

describe('/init payload', () => {
  it('renders the CC-faithful init instruction', () => {
    const content = initContent()
    expect(content.type).toBe('text')
    expect(content.text).toContain('Analyze the current repository')
    expect(content.text).toContain('CLAUDE.md')
    expect(content.text).toContain('verify them against what the repository actually defines')
    expect(INIT_PROMPT).toContain('write a CLAUDE.md')
  })
})

describe('/init human command', () => {
  it('acknowledges initialization and hands the model a follow-up turn', async () => {
    const { ctx, agent, followups } = await harness()
    const execution = await ctx.commands.execute(agent, '/init', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    expect((execution?.result as { text: string }).text).toBe('Initializing CLAUDE.md…')
    expect(followups).toHaveLength(1)
    const message = followups[0]!
    expect(message.role).toBe('user')
    const text = message.content.find(block => block.type === 'text')
    expect(text && 'text' in text ? text.text : '').toContain('Analyze the current repository')
  })
})

describe('/init help interception', () => {
  it('answers a trailing help argument with formatted help text', async () => {
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/init help', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = execution?.result.text ?? ''
    expect(text).toContain('/init')
    expect(text).toContain('Usage:')
  })
})
