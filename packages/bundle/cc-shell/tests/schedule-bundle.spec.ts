import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Service } from '@deepseek-ai/cordis'
import * as toolSchedule from '@deepseek-ai/dsh-schedule'

/** Minimal sessionPersistence service mount (mirrors upstream schedule
 * plugin.spec's PersistenceProbe: the schedule plugin only requires the
 * service to exist, never calls its read/write face in this composition). */
class PersistenceProbe extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }
}

/**
 * cc-shell bundle schedule row (`@deepseek-ai/dsh-schedule`). Mirrors the
 * upstream plugin.spec pattern (real services, direct tool execution) rather
 * than a full-timing loop — deterministic. assert_shape: the tool registers on
 * future root agents and a schedule_create call appends schedule/change.
 */
async function harness(): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(PersistenceProbe)
  ctx.on('session/flush', () => {})
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

describe('@deepseek-ai/dsh-schedule bundled by cc-shell', () => {
  it('has the Loader-safe function-plugin export shape', () => {
    expect('default' in toolSchedule).toBe(false)
    expect(toolSchedule.name).toBe('schedule')
    expect(toolSchedule.inject).toEqual(['agents', 'sessions', 'tools', 'sessionPersistence'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(toolSchedule)).toBe(toolSchedule)
  })

  it('registers schedule_create/list/delete on future root agents and appends schedule/change', async () => {
    const ctx = await harness()
    const existing = await ctx.agents.create({ sessionId: SessionId('cc-schedule-existing') })
    const plugin = await ctx.plugin(toolSchedule)
    expect(ctx.tools.get('schedule_create', existing.agent)).toBeUndefined()

    const root = await ctx.agents.create({ sessionId: SessionId('cc-schedule-root') })
    expect(ctx.tools.get('schedule_create', root.agent)?.name).toBe('schedule_create')
    expect(ctx.tools.get('schedule_list', root.agent)?.name).toBe('schedule_list')
    expect(ctx.tools.get('schedule_delete', root.agent)?.name).toBe('schedule_delete')
    expect(ctx.tools.get('schedule_create')).toBeUndefined()

    const created = await ctx.agents.withInitiator(root.agent, () => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('cc-schedule-create'),
      name: 'schedule_create',
      arguments: { prompt: 'future reminder', after_seconds: 3600 },
      agent: root.agent,
    }))
    expect(created.isError).toBe(false)
    if (created.isError) throw new Error('expected Schedule create value')
    expect(created.value).toMatchObject({ id: 'schedule-1', deliveryMode: 'session-local' })

    // The durable create appended a schedule/change event to the session log.
    expect(root.agent.session.snapshotEvents().some(e => e.type === 'schedule/change')).toBe(true)

    await plugin.dispose()
    expect(ctx.tools.get('schedule_create', root.agent)).toBeUndefined()

    await root.dispose()
    await existing.dispose()
    await ctx.fiber.dispose()
  })
})
