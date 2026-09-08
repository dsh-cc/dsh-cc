/**
 * Composition-level integration: plan-mode mounted inside an entry-local
 * isolate realm — mirroring the vendored preset's `planning` group
 * (packages/preset/cc/agent.cordis.yml) — is invisible to
 * `ctx.get('planMode')` everywhere outside the realm, yet `/permissions`
 * must still switch plan mode through the `/plan` command channel. This is
 * the test that would have caught the realm bug at introduction
 * (docs/plan-mode-command-channel.md §9.4): every service here is REAL
 * (session store, command runtime, plan-mode), only the rules engine is
 * stubbed, and the agent is the usual structural stand-in over a real
 * Session.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import PlanMode from '@deepseek-ai/dsh-plan-mode'
import { foldPlanMode } from '@dsh-cc/permission-rules'
import * as commandPermissions from '@dsh-cc/command-permissions'

async function boot(): Promise<{
  ctx: Context
  agent: Agent
  calls: string[]
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  // The crux of the production composition: plan-mode lives behind an
  // entry-local isolate realm, so its service is invisible here by design.
  const realm = ctx.isolate('planMode')
  await realm.plugin(PlanMode, { section: 'plan policy text' })
  const calls: string[] = []
  ctx.reflect.provide('permissionRules', {
    ruleSet: { allow: [], deny: [], ask: [], bypassImmune: [] },
    setMode: (_agent: Agent, mode: string) => { calls.push(`setMode:${mode}`) },
  })
  // The host command sits OUTSIDE the realm, exactly like its preset row.
  await ctx.plugin(commandPermissions)
  const session = ctx.sessions.create(SessionId(`plan-channel-${Math.random()}`))
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
  return { ctx, agent, calls }
}

describe('plan switching through the command channel (composition-level)', () => {
  it('enters plan mode via /permissions plan despite the realm-invisible service', async () => {
    const { ctx, agent } = await boot()
    // The realm condition this test stands guard over: nobody outside the
    // planning group may resolve the service directly.
    expect(ctx.get('planMode')).toBeUndefined()
    const execution = await ctx.commands.execute(agent, '/permissions plan', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
  })

  it('re-entering plan is a no-op answered locally, not re-dispatched', async () => {
    const { ctx, agent } = await boot()
    await ctx.commands.execute(agent, '/permissions plan', [], new AbortController().signal)
    const second = await ctx.commands.execute(agent, '/permissions plan', [], new AbortController().signal)
    // Had it re-dispatched, the real /plan handler would answer with its own
    // entering/already-active narration instead of this branch's text.
    expect((second?.result as { text: string }).text).toBe('Permission mode is now "plan".')
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
  })

  it('/permissions auto exits plan through /plan off before switching the engine', async () => {
    const { ctx, agent, calls } = await boot()
    await ctx.commands.execute(agent, '/permissions plan', [], new AbortController().signal)
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(true)
    const execution = await ctx.commands.execute(agent, '/permissions auto', [], new AbortController().signal)
    expect((execution?.result as { text: string }).text).toBe('Permission mode is now "auto".')
    expect(foldPlanMode(agent.session.snapshotEvents())).toBe(false)
    expect(calls).toEqual(['setMode:auto'])
    // The exit really went through plan-mode: both transitions are logged.
    const planEvents = agent.session.snapshotEvents()
      .filter(event => event.type === 'plan/mode')
      .map(event => event.data.active)
    expect(planEvents).toEqual([true, false])
  })
})
