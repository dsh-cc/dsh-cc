import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Storage from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as toolSchedule from '@deepseek-ai/dsh-schedule'
import * as toolScheduleTools from '@deepseek-ai/dsh-tool-schedule'

/** In-memory StorageBackend: per-record maps plus the optional global slot. */
class MemoryBackend implements StorageBackend {
  readonly units = new Map<string, { tables: Map<string, Map<string, unknown>>; global: unknown }>()

  readonly kv = {
    open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
      if (this.units.has(descriptor.name)) throw new Error(`unit "${descriptor.name}" already open`)
      const unit = { tables: new Map(descriptor.tables.map(name => [name, new Map<string, unknown>()])), global: null as unknown }
      this.units.set(descriptor.name, unit)
      return {
        loadAll: async () => ({
          tables: Object.fromEntries([...unit.tables].map(([name, rows]) => [name, Object.fromEntries(rows)])),
          global: unit.global,
        }),
        putRecord: async (table, key, value) => { unit.tables.get(table)!.set(key, structuredClone(value)) },
        deleteRecord: async (table, key) => { unit.tables.get(table)!.delete(key) },
        setGlobal: async (value) => { unit.global = structuredClone(value) },
        close: async () => { this.units.delete(descriptor.name) },
      }
    },
  }

  async close(): Promise<void> {}
}

/** Mount the ScheduleService prerequisites with an in-memory durable medium. */
async function harness(): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Storage.default)
  const backend = new MemoryBackend()
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  ctx.provide('sessionController', { resolveAgent: async () => { throw new Error('missing Session') } } as never)
  // AgentLoop.create persists new sessions — the empty `as never` provide
  // crashed at 0.1.7 (handle-model `persistence.create`). Mount the real
  // jsonl persistence into a tmp root.
  const persistenceRoot = mkdtempSync(join(tmpdir(), 'cc-schedule-bundle-'))
  await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
  ctx.on('session/flush', () => {})
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

describe('@deepseek-ai/dsh-schedule bundled by cc-shell', () => {
  it('has the Loader-safe class-plugin export shape', () => {
    // 0.1.7-rc.2 shape: the plugin is the class itself, exported as the
    // DEFAULT only (no `ScheduleService` named export); the loader must
    // unwrap the module namespace to that class. 0.2.1-rc.5 dropped `tools`
    // from the service's inject list: the model-facing reminder tools moved to
    // the preset-scoped `@deepseek-ai/dsh-tool-schedule` package.
    expect(typeof toolSchedule.default).toBe('function')
    expect((toolSchedule.default as unknown as { inject: string[] }).inject).toEqual(
      ['agents', 'sessions', 'storageDomain', 'sessionController', 'sessionPersistence'],
    )
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(toolSchedule)).toBe(toolSchedule.default)
  })

  it('registers schedule_create/list/update/delete on future root agents and creates durable tasks', async () => {
    const ctx = await harness()
    const changed: unknown[] = []
    ctx.on('schedule/changed', () => { changed.push(true) })
    const existing = await ctx.agents.create({ sessionId: SessionId('cc-schedule-existing') })
    expect(ctx.tools.get('schedule_create', existing.agent)).toBeUndefined()

    // Mount after the old agent exists: tools land on FUTURE root agents.
    await ctx.plugin(toolSchedule.default, {})
    await ctx.plugin(toolScheduleTools)
    const root = await ctx.agents.create({ sessionId: SessionId('cc-schedule-root') })
    expect(ctx.tools.get('schedule_create', root.agent)?.name).toBe('schedule_create')
    expect(ctx.tools.get('schedule_list', root.agent)?.name).toBe('schedule_list')
    expect(ctx.tools.get('schedule_update', root.agent)?.name).toBe('schedule_update')
    expect(ctx.tools.get('schedule_delete', root.agent)?.name).toBe('schedule_delete')
    // No agentless-catalog pin here: `@deepseek-ai/dsh-tool-schedule` registers
    // in the MOUNTING scope (0.2.1-rc.5), so its names resolve without an agent
    // — unlike the old host-plane registration the service used to perform.

    const created = await ctx.agents.withInitiator(root.agent, () => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('cc-schedule-create'),
      name: 'schedule_create',
      arguments: { title: 'future reminder', prompt: 'future reminder', after_seconds: 3600 },
      agent: root.agent,
    }))
    expect(created.isError).toBe(false)
    if (created.isError) throw new Error('expected Schedule create value')
    expect(created.value).toMatchObject({ kind: 'after', prompt: 'future reminder', deliveryMode: 'host' })

    // The durable create landed in storage and announced itself post-commit.
    expect(changed.length).toBeGreaterThan(0)
    expect((await ctx.schedule.catalog()).some(entry => entry.prompt === 'future reminder')).toBe(true)

    await existing.dispose()
    await root.dispose()
    await ctx.fiber.dispose()
  })

  it('refuses a delegated child at execute time with subagent_session', async () => {
    // The CC preset mounts the row unconditionally: refusing children is the
    // tools' own execute-time check (`delegationDepthOf(agent) > 0`), not a
    // toolFilter.deny list, so the names stay in the child's catalog.
    const ctx = await harness()
    await ctx.plugin(toolSchedule.default, {})
    await ctx.plugin(toolScheduleTools)
    const root = await ctx.agents.create({ sessionId: SessionId('cc-schedule-root-2') })
    const child = await ctx.agents.create({
      sessionId: SessionId('cc-schedule-child'),
      parentAgent: root.agent,
      meta: { delegationDepth: 1, origin: 'subagent' },
    })
    expect(child.agent.session.header.delegationDepth).toBe(1)
    expect(ctx.tools.get('schedule_list', child.agent)?.name).toBe('schedule_list')

    const refused = await ctx.agents.withInitiator(child.agent, () => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('cc-schedule-child-list'),
      name: 'schedule_list',
      arguments: {},
      agent: child.agent,
    }))
    expect(refused.isError).toBe(false)
    if (refused.isError) throw new Error('expected a Schedule tool refusal value')
    expect(refused.value).toMatchObject({ code: 'subagent_session' })

    await child.dispose()
    await root.dispose()
    await ctx.fiber.dispose()
  })
})
