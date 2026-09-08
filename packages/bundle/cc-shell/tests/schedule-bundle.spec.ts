import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionPersistence,
  SessionPersistenceRevision,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionAccess, SessionHandle, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import * as toolSchedule from '@deepseek-ai/dsh-schedule'

interface StoredProbeSession {
  readonly header: SessionHeader
  readonly events: SessionEvent[]
}

/** In-memory handle-based persistence, just enough for agent-loop's write path
 * (mirrors upstream schedule plugin.spec's PersistenceProbe). */
class PersistenceProbe extends SessionPersistence {
  private readonly stored = new Map<string, StoredProbeSession>()

  override async create(header: SessionHeader): Promise<SessionHandle> {
    const entry: StoredProbeSession = { header, events: [] }
    this.stored.set(header.id, entry)
    return this.handle(entry, 'write')
  }

  // Appends are durable on resolution here; nothing buffers, so the service-wide flush is a no-op.
  override async flush(): Promise<void> {}

  override async open(id: SessionId, access: SessionAccess): Promise<SessionHandle> {
    const entry = this.stored.get(id)
    if (entry === undefined) throw new Error(`session ${id} not found`)
    return this.handle(entry, access)
  }

  override async stat(id: SessionId): Promise<SessionPersistenceSnapshot | undefined> {
    const entry = this.stored.get(id)
    return entry === undefined ? undefined : this.snapshot(entry)
  }

  override async list(): Promise<SessionPersistenceSnapshot[]> {
    return [...this.stored.values()].map(entry => this.snapshot(entry))
  }

  private snapshot(entry: StoredProbeSession): SessionPersistenceSnapshot {
    return {
      header: entry.header,
      revision: SessionPersistenceRevision(`probe-${entry.header.id}-${entry.events.length}`),
      eventCount: entry.events.length,
    }
  }

  private handle(entry: StoredProbeSession, access: SessionAccess): SessionHandle {
    return {
      id: entry.header.id,
      header: entry.header,
      inheritedEventCount: SessionLogOffset(0),
      access,
      read: async (offset = 0, length = Number.MAX_SAFE_INTEGER) =>
        ({ eventState: 'detached', events: structuredClone(entry.events.slice(offset, offset + length)) }),
      append: async (events) => { entry.events.push(...events) },
      flush: async () => {},
      close: async () => {},
      [Symbol.asyncDispose]: async () => {},
    }
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
