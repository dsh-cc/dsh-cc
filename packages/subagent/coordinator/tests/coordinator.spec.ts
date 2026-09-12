import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { defineTool } from '@dsh-cc/tools'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'
import * as coordinator from '../src/index.ts'
import { parkParent } from './park-parent.ts'

const testToolSignal = new AbortController().signal

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-coordinator-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  // sendMessage's cold-resume delivery resolves sessions through session-query.
  await ctx.plugin(SessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  // A small deployment tool surface: two write tools and two read-only tools,
  // so the coordinator's default mask can be observed removing the writers.
  ctx.tools.register(defineTool({ name: 'write', description: 'write', parameters: {}, output: { schema: { type: 'null' }, render: () => [] }, async execute() { return null } }))
  ctx.tools.register(defineTool({ name: 'edit', description: 'edit', parameters: {}, output: { schema: { type: 'null' }, render: () => [] }, async execute() { return null } }))
  ctx.tools.register(defineTool({ name: 'read', description: 'read', parameters: {}, output: { schema: { type: 'null' }, render: () => [] }, async execute() { return null } }))
  ctx.tools.register(defineTool({ name: 'search', description: 'search', parameters: {}, output: { schema: { type: 'null' }, render: () => [] }, async execute() { return null } }))
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  parkParent(ctx, parent)
  return { ctx, parent }
}

/** Read one stored session's header + event log through the rc.1
 * sessionPersistence face (`stat` + a read `open` handle); `undefined` when
 * the session does not exist. */
async function loadStoredSession(persistence: {
  stat(id: SessionId): Promise<unknown>
  open(id: SessionId, access: 'read'): Promise<{ header: SessionHeader; read(): Promise<{ events: readonly SessionEvent[] }>; close(): Promise<void> }>
}, id: SessionId): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] } | undefined> {
  if (await persistence.stat(id) === undefined) return undefined
  const handle = await persistence.open(id, 'read')
  try {
    return { meta: handle.header, events: (await handle.read()).events }
  } finally {
    await handle.close()
  }
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

let calls = 0
function callTool(
  ctx: Context,
  name: string,
  args: unknown,
  agent: unknown,
) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++calls}`),
    name,
    arguments: args,
    agent: agent as never,
  })
}

function visibleTools(ctx: Context, parent: unknown): string[] {
  return ctx.tools.schemas(parent as never).map(schema => schema.name).sort()
}

describe('dsh-coordinator mode activation', () => {
  it('is inactive by default and activates from Config or env', () => {
    expect(coordinator.isCoordinatorActive({})).toBe(false)
    expect(coordinator.isCoordinatorActive({ enabled: true })).toBe(true)
    expect(coordinator.isCoordinatorActive({ enabled: false })).toBe(false)
    const prior = process.env.DSH_COORDINATOR_MODE
    process.env.DSH_COORDINATOR_MODE = '1'
    try {
      expect(coordinator.isCoordinatorActive({})).toBe(true)
    } finally {
      if (prior === undefined) delete process.env.DSH_COORDINATOR_MODE
      else process.env.DSH_COORDINATOR_MODE = prior
    }
  })

  it('applies the write-tool restriction and installs scheduling tools + section', async () => {
    const { ctx, parent } = await setup([])
    const before = visibleTools(ctx, parent)
    expect(before).toContain('write')
    expect(before).toContain('edit')

    const dispose = coordinator.installCoordinatorMode(parent, ctx, { enabled: true })

    const after = visibleTools(ctx, parent)
    expect(after).not.toContain('write')
    expect(after).not.toContain('edit')
    expect(after).toContain('read')
    expect(after).toContain('search')
    for (const name of ['spawn_worker', 'send_to_worker', 'worker_broadcast', 'worker_tasks']) {
      expect(after).toContain(name)
    }

    const assembly = await ctx.systemPrompt.assemble({ scope: parent })
    const section = assembly.sections.find(entry => entry.name === 'coordinator:mode')
    expect(section).toBeDefined()
    expect(section!.text).toContain('Coordinator mode')
    expect(section!.text).toContain('send_message')
    expect(section!.text).toContain('subagent-settled')

    dispose()
    const restored = visibleTools(ctx, parent)
    expect(restored).toContain('write')
    expect(restored).toContain('edit')
    expect(restored).not.toContain('spawn_worker')
  })

  it('honors a configured allow mask over the default deny', async () => {
    const { ctx, parent } = await setup([])
    const dispose = coordinator.installCoordinatorMode(parent, ctx, {
      enabled: true,
      restrict: { allow: ['read'] },
    })
    const after = visibleTools(ctx, parent)
    // Only the allow-listed global remains visible; the scoped coordinator
    // tools merge afterwards and are unaffected by the global mask.
    expect(after).toContain('read')
    expect(after).not.toContain('write')
    expect(after).not.toContain('edit')
    expect(after).not.toContain('search')
    for (const name of ['spawn_worker', 'send_to_worker', 'worker_broadcast', 'worker_tasks']) {
      expect(after).toContain(name)
    }
    dispose()
  })

  it('is a no-op when disabled (registers nothing)', async () => {
    const { ctx, parent } = await setup([])
    const before = visibleTools(ctx, parent)
    // The gating layer (apply) mounts nothing when mode is inactive.
    const dispose = coordinator.apply(parent.ctx, { enabled: false })
    expect(visibleTools(ctx, parent)).toEqual(before)
    dispose()
  })

  it('re-activation reproduces the mode (resume keeps the config-driven state)', async () => {
    const { ctx, parent } = await setup([])
    const first = coordinator.installCoordinatorMode(parent, ctx, { enabled: true })
    expect(visibleTools(ctx, parent)).not.toContain('write')
    first()

    // A resumed session re-mounts the coordinator preset, reproducing the mode.
    const second = coordinator.installCoordinatorMode(parent, ctx, { enabled: true })
    expect(visibleTools(ctx, parent)).not.toContain('write')
    expect(visibleTools(ctx, parent)).toContain('spawn_worker')
    second()
    expect(visibleTools(ctx, parent)).toContain('write')
  })

  it('fails loud when activated outside an agent scope', () => {
    const ctx = new Context()
    expect(() => coordinator.apply(ctx, { enabled: true })).toThrow(/agent-scoped context/)
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in coordinator).toBe(false)
    expect(coordinator.name).toBe('coordinator')
    expect(coordinator.inject).toEqual(['tools', 'subagents', 'agents', 'systemPrompt'])
    expect(typeof coordinator.apply).toBe('function')
    expect(typeof coordinator.installCoordinatorMode).toBe('function')
  })
})

describe('dsh-coordinator named worker routing', () => {
  it('spawn_worker names a child and send_to_worker delivers a follow-up by name', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('second')])
    coordinator.installCoordinatorMode(parent, ctx, { enabled: true })

    const spawned = await callTool(ctx, 'spawn_worker', { name: 'alpha', prompt: 'do task' }, parent)
    expect(spawned.isError).toBe(false)
    const workerId = (spawned.content as Array<{ type: string; text?: string }>).find(b => b.type === 'text')?.text
    expect(workerId).toContain('alpha started as')
    const sent = await callTool(ctx, 'send_to_worker', {
      worker: 'alpha',
      message: 'and extend it',
    }, parent)
    expect(sent.isError).toBe(false)
    expect(text(sent)).toContain('message delivered to worker alpha')
  })

  it('send_to_worker\'s message reaches the spawned worker\'s persisted session via sendMessage', async () => {
    // The production delivery path end-to-end: the tool resolves the worker,
    // calls ctx.subagents.sendMessage (steer semantics), and the formatted
    // message lands durably on the worker's own session log.
    const { ctx, parent } = await setup([textResponse('first'), textResponse('second')])
    coordinator.installCoordinatorMode(parent, ctx, { enabled: true })

    const spawned = await callTool(ctx, 'spawn_worker', { name: 'alpha', prompt: 'do task' }, parent)
    const childId = SessionId(text(spawned).match(/as ([A-Za-z0-9-]+)$/)![1]!)
    const sent = await callTool(ctx, 'send_to_worker', { worker: 'alpha', message: 'and extend it' }, parent)
    expect(sent.isError).toBe(false)

    await vi.waitFor(async () => {
      const loaded = await loadStoredSession(ctx.sessionPersistence, childId)
      const childTexts = loaded.events
        .flatMap(event => event.type === 'user/message' ? event.data.content : [])
        .flatMap(block => block.type === 'text' ? [block.text] : [])
      expect(childTexts.some(entry => entry.includes('do task'))).toBe(true)
      const delivered = loaded.events
        .filter(event => event.type === 'user/message'
          && (event.data.content as { type: string; text?: string }[]).some(
            block => block.type === 'text' && block.text?.includes('sent a message'),
          ))
        .map(event => (event.data.content as { type: string; text?: string }[])
          .flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
      expect(delivered.some(entry => entry.includes('and extend it'))).toBe(true)
    }, { timeout: 10_000 })
  }, 20_000)

  it('worker_tasks lists the named worker once spawned', async () => {
    const { ctx, parent } = await setup([textResponse('child'), textResponse('child2')])
    coordinator.installCoordinatorMode(parent, ctx, { enabled: true })
    await callTool(ctx, 'spawn_worker', { name: 'beta', prompt: 'work' }, parent)
    const listed = await callTool(ctx, 'worker_tasks', {}, parent)
    expect(listed.isError).toBe(false)
    expect(text(listed)).toContain('beta')
  })

  it('rejects send_to_worker for an unknown worker', async () => {
    const { ctx, parent } = await setup([])
    coordinator.installCoordinatorMode(parent, ctx, { enabled: true })
    const result = await callTool(ctx, 'send_to_worker', { worker: 'nope', message: 'hi' }, parent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unknown worker')
  })

  it('worker_broadcast delivers one message to every active worker', async () => {
    const { ctx, parent } = await setup([textResponse('a'), textResponse('b'), textResponse('c'), textResponse('d')])
    coordinator.installCoordinatorMode(parent, ctx, { enabled: true })
    await callTool(ctx, 'spawn_worker', { name: 'one', prompt: 'a' }, parent)
    await callTool(ctx, 'spawn_worker', { name: 'two', prompt: 'b' }, parent)
    const broadcast = await callTool(ctx, 'worker_broadcast', { message: 'sync' }, parent)
    expect(broadcast.isError).toBe(false)
    expect(text(broadcast)).toContain('delivered to 2 workers')
  })

  it('fails loud when a scheduling tool has no calling agent', async () => {
    const { ctx, parent } = await setup([])
    coordinator.installCoordinatorMode(parent, ctx, { enabled: true })
    // Execute without an agent carrier: the coordinator tools require one.
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('call-x'),
      name: 'worker_tasks',
      arguments: {},
    })
    expect(result.isError).toBe(true)
  })
})

describe('dsh-coordinator completion notification (reused subagent-settled protocol)', () => {
  it('receives a waking subagent-settled notice when a named worker settles', async () => {
    // Two script entries: the child's turn, then the parent's own turn that the
    // settlement notice wakes. Mirrors the dsh-subagent continuation settlement
    // suite that owns this protocol.
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const root = mkdtempSync(join(tmpdir(), 'dsh-coordinator-notify-'))
    roots.push(root)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    ctx.tools.register(defineTool({ name: 'write', description: 'write', parameters: {}, output: { schema: { type: 'null' }, render: () => [] }, async execute() { return null } }))
    ctx.tools.register(defineTool({ name: 'edit', description: 'edit', parameters: {}, output: { schema: { type: 'null' }, render: () => [] }, async execute() { return null } }))
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('child answer'), textResponse('parent ack')]))
    const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
    coordinator.installCoordinatorMode(parent, ctx, { enabled: true })

    const spawned = await callTool(ctx, 'spawn_worker', { name: 'gamma', prompt: 'work' }, parent)
    expect(spawned.isError).toBe(false)
    const workerIdMatch = text(spawned).match(/as ([A-Za-z0-9-]+)$/)
    const childId = SessionId(workerIdMatch![1]!)

    // The worker (a continuable child) settles after its scripted turn; the
    // subagent manager injects its subagent-settled notice into the coordinator
    // parent's session as a durable waking message — the completion protocol
    // this package reuses rather than reimplements.
    await vi.waitFor(() => {
      const userEvents = parent.session.snapshotEvents()
        .flatMap(event => event.type === 'user/message' ? [event.data] : [])
      expect(userEvents.some(m =>
        m.source.kind === 'subagent-settled' && m.source.senderSessionId === childId)).toBe(true)
    }, { timeout: 5_000 })
  })
})
