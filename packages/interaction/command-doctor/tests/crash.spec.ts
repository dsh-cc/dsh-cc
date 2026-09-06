import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as commandDoctor from '@dsh-cc/command-doctor'
import { collect } from '../src/collect.ts'
import { CLOCK, fakeInvocation, mountThrowing } from './helpers.ts'

function makeAgent(ctx: Context): Agent {
  const session = ctx.sessions.create(SessionId(`doctor-crash-${Math.random()}`))
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

describe('crash isolation', () => {
  it('turns a throwing seam getter into that group failing while the command succeeds', async () => {
    const ctx = new Context()
    mountThrowing(ctx, 'ccModelRoutes', new Error('boom'))
    const report = await collect(ctx, fakeInvocation(), CLOCK)
    const models = report.checks.filter(check => check.group === 'models')
    expect(models.some(check => check.status === 'fail' && check.summary.includes('boom'))).toBe(true)
    // Every other group still collected.
    expect(report.checks.some(check => check.group === 'env')).toBe(true)
    expect(report.checks.some(check => check.group === 'seams')).toBe(true)
  })

  it('the command still returns success when every seam getter throws', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(commandDoctor)
    for (const seam of ['ccModelRoutes', 'mcpConnections', 'hookBridgeStatus', 'ccPlugins', 'web', 'llm', 'dshProfile']) {
      mountThrowing(ctx, seam, new Error(`kaboom-${seam}`))
    }
    const agent = makeAgent(ctx)
    ctx.agents.register(agent)
    const execution = await ctx.commands.execute(agent, '/doctor', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('summary:')
    expect(text).toMatch(/fail/)
  })
})
