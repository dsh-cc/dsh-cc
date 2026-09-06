import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as commandSkills from '@dsh-cc/command-skills'
import { formatSkill, formatSkills, invocationLabel } from '@dsh-cc/command-skills/skills'

function stubAgent(session: ReturnType<Context['sessions']['create']>): Agent {
  return {
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
}

async function harness(): Promise<{
  ctx: Context
  agent: Agent
  plugin: Awaited<ReturnType<Context['plugin']>>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  const plugin = await ctx.plugin(commandSkills)
  ctx.skills.register({ name: 'bootstrap', description: 'scaffold a project' })
  ctx.skills.register({
    name: 'triage',
    description: 'triage an issue',
    invocation: { modelInvocable: true, userInvocable: false },
  })
  const session = ctx.sessions.create(SessionId(`command-skills-${Math.random()}`))
  const agent = stubAgent(session)
  ctx.agents.register(agent)
  return { ctx, agent, plugin }
}

describe('@dsh-cc/command-skills registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    expect(commandSkills.name).toBe('command-skills')
    expect(commandSkills.inject).toEqual(['commands', 'skills'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandSkills)).toBe(commandSkills)
    const { ctx, agent, plugin } = await harness()
    expect(ctx.commands.find(agent, 'skills')).toBeDefined()
    await plugin.dispose()
    expect(ctx.commands.find(agent, 'skills')).toBeUndefined()
  })
})

describe('/skills rendering', () => {
  it('labels invocation policy from both flags', () => {
    expect(invocationLabel({ invocation: { modelInvocable: true, userInvocable: true } } as never)).toBe('model and user')
    expect(invocationLabel({ invocation: { modelInvocable: true, userInvocable: false } } as never)).toBe('model')
    expect(invocationLabel({ invocation: { modelInvocable: false, userInvocable: true } } as never)).toBe('user')
  })
  it('renders a sorted catalog with source and invocation', async () => {
    const { ctx } = await harness()
    const summaries = await ctx.skills.list()
    expect(summaries.map(s => s.name)).toEqual(['bootstrap', 'triage'])
    expect(formatSkill(summaries.find(s => s.name === 'bootstrap')!)).toContain('invocable by: model and user')
    const text = formatSkills(summaries)
    const lines = text.split('\n')
    expect(lines[0]!).toContain('bootstrap — scaffold a project')
    expect(lines[1]!).toContain('triage — triage an issue')
  })
})

describe('/skills human command', () => {
  it('lists the registered skills', async () => {
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/skills', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('bootstrap')
    expect(text).toContain('triage')
    expect(text).toContain('invocable by: model')
  })

  it('lists preset-layer skills when invoked by a scoped agent', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(commandSkills)
    const preset = createScope(ctx, { preset: 'cc' })
    const skills = preset.ctx.get('skills')
    if (skills === undefined) throw new Error('skills service missing')
    skills.register({
      name: 'preset-skill',
      description: 'a skill only visible through the preset layer',
      source: 'preset',
    })
    const session = ctx.sessions.create(SessionId(`command-skills-scoped-${Math.random()}`))
    const agent = stubAgent(session)
    bindScopeParent(agent, scopeOf(preset.ctx) as object)
    ctx.agents.register(agent)

    expect(await ctx.skills.list()).toEqual([])
    expect((await ctx.skills.list({ scope: agent })).map(s => s.name)).toEqual(['preset-skill'])

    const execution = await ctx.commands.execute(agent, '/skills', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('preset-skill')
    expect(text).not.toBe('No skills registered.')

    await preset.dispose()
  })
})
