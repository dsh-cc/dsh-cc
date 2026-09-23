import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type ToolExecutionInput, type ToolExecutionResult } from '@dsh-cc/tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import PermissionRules, { PERMISSION_SETTINGS_NAMESPACE, foldProbes, type Config } from '@dsh-cc/permission-rules'
import type { Agent } from '@deepseek-ai/dsh-agent'

const testToolSignal = new AbortController().signal

function texts(result: { content: ContentBlock[] }): string[] {
  return result.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text)
}

/** Flatten the text of a sideband context entry (UserMessage content blocks). */
function contextTexts(contexts: readonly { content: ContentBlock[] }[]): string[] {
  return contexts.flatMap(message => message.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text))
}

class MemorySettings extends SettingsProvider {
  readonly doc: Record<string, unknown> = {}
  readonly writable = true

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

/** Fake `llm` service: records stream calls; classifier lane + probe lane both script here. */
class FakeLlm extends Service {
  calls: { maxTokens: number; system: string; prompt: string }[] = []
  scripted: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  async *stream(options: { maxTokens: number; system: string; prompt: string }): AsyncIterable<{ type: 'text-delta'; index: number; text: string } | { type: 'finish'; reason: { kind: string } }> {
    this.calls.push(options)
    const scripted = this.scripted.shift()
    const text = scripted ?? (options.maxTokens === 256
      ? '{"injection":false,"reason":"clean"}'
      : '{"verdict":"allow","reason":"ok"}')
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  async resolveModelInfo(): Promise<Record<string, never>> {
    return {}
  }
}

class FakeRoutes extends Service {
  route = { provider: 'fake', model: 'probe-model' }

  constructor(ctx: Context) {
    super(ctx, 'ccModelRoutes')
  }

  resolve(): { provider: string; model: string } {
    return this.route
  }

  resolveDetailed(): { selector: string; via: 'alias'; route: { provider: string; model: string } } {
    return { selector: 'probe-model', via: 'alias', route: this.resolve() }
  }
}

async function mount(): Promise<{ ctx: Context; llm: FakeLlm }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(MemorySettings)
  await ctx.plugin(FakeRoutes)
  await ctx.plugin(FakeLlm)
  const llm = ctx.get('llm') as FakeLlm
  await ctx.plugin(PermissionRules, {
    fileEditTools: ['edit'],
    readOnlyTools: ['read'],
    bashToolName: 'Bash',
  } as Config)
  ctx.tools.register(defineContentToolFixture({
    name: 'read',
    description: 'read file',
    parameters: { file_path: { type: 'string' } },
    async execute(args) { return [{ type: 'text', text: `read:${(args as { file_path: string }).file_path}` }] },
  }))
  return { ctx, llm }
}

function exec(name: string, args: unknown, agent?: Agent): ToolExecutionInput {
  return {
    signal: testToolSignal,
    callId: ToolCallId('c1'),
    name,
    arguments: args,
    ...(agent ? { agent } : {}),
  }
}

function agentOf(id: string, cwd = '/work'): Agent {
  const session = Session.create(SessionId(id), undefined, { version: 3, isSeeded: false, id: SessionId(id), createdAt: Date.now(), cwd })
  session.append('turn/start', { turn: 1 })
  return { id, session, inject: () => {} } as unknown as Agent
}


describe('S7 listener × PI probe (integration)', () => {
  it('auto mode + flag verdict: warning delivered via additionalContexts sideband; probe audit event appended', async () => {
    const { ctx, llm } = await mount()
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { probe: {} } })
    llm.scripted = ['{"injection":true,"reason":"override attempt"}']
    const agent = agentOf('probe-flag')
    ctx.permissionRules.setMode(agent, 'auto')

    const result = await ctx.tools.execute(exec('read', { file_path: '/work/evil.txt' }, agent))
    const contexts = (result as unknown as { additionalContexts?: { content: ContentBlock[] }[] }).additionalContexts ?? []
    const [warning] = contextTexts(contexts)
    expect(warning).toContain('Security notice')
    expect(warning).toContain('prompt-injection probe')
    expect(texts(result)).toEqual(['read:/work/evil.txt']) // content untouched
    const folded = foldProbes(agent.session.snapshotEvents())
    expect(folded.at(-1)).toMatchObject({ tool: 'read', verdict: 'flag', reason: 'override attempt', provider: 'fake', model: 'probe-model' })
  })

  it('non-auto modes: the probe never runs (no stream call, no audit)', async () => {
    const { ctx, llm } = await mount()
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { probe: {} } })
    const agent = agentOf('probe-default')
    ctx.permissionRules.setMode(agent, 'default')

    await ctx.tools.execute(exec('read', { file_path: '/work/x.txt' }, agent))
    expect(llm.calls).toHaveLength(0)
    expect(foldProbes(agent.session.snapshotEvents())).toHaveLength(0)
  })

  it('probe disabled (probe.enabled false): never runs even in auto', async () => {
    const { ctx, llm } = await mount()
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { probe: { enabled: false } } })
    const agent = agentOf('probe-off')
    ctx.permissionRules.setMode(agent, 'auto')

    await ctx.tools.execute(exec('read', { file_path: '/work/x.txt' }, agent))
    expect(llm.calls).toHaveLength(0)
expect(foldProbes(agent.session.snapshotEvents())).toHaveLength(0)
  })

  it('BOTH load orders: a content-replacing listener in PREPEND order (crusher-style, outermost) rewrites content wholesale — the probe warning SURVIVES via the additionalContexts sideband; never throws', async () => {
    const { ctx, llm } = await mount()
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { probe: {} } })
    llm.scripted = ['{"injection":true,"reason":"bad"}']
    const seenByOuter: { content: ContentBlock[] }[] = []
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      const d = await next()
      if (d.kind !== 'accept') return d
      // Capture the decision the outer (prepend-order) listener receives:
      // the probe's warning already attached (the probe composes INSIDE).
      if (d.additionalContexts !== undefined) seenByOuter.push(...d.additionalContexts)
      // Crusher-style rewrite: replace the content wholesale (new array).
      return { ...d, content: [{ type: 'text', text: 'CCR-REWRITTEN' }] }
    }, { prepend: true })
    const agent = agentOf('probe-prepend-crusher')
    ctx.permissionRules.setMode(agent, 'auto')

    const result = await ctx.tools.execute(exec('read', { file_path: '/work/x.txt' }, agent))
    expect(contextTexts(seenByOuter)).toEqual([
      expect.stringContaining('Security notice'),
    ])
    // The outer rewrite replaces content (its prerogative) — but the sideband
    // survives the spread, so the warning still arrives.
    expect(texts(result)).toEqual(['CCR-REWRITTEN'])
    const contexts = (result as unknown as { additionalContexts?: { content: ContentBlock[] }[] }).additionalContexts ?? []
    expect(contextTexts(contexts)).toEqual([expect.stringContaining('Security notice')])
  })

  it('CLOBBER-PROOF: an inner default-order listener that REPLACES the result content (CCR-style) cannot drop the probe warning — it arrives via additionalContexts', async () => {
    const { ctx, llm } = await mount()
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { probe: {} } })
    llm.scripted = ['{"injection":true,"reason":"bad"}']
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      const d = await next()
      if (d.kind !== 'accept') return d
      // Wholesale content replacement: every original block is dropped.
      return { ...d, content: [{ type: 'text', text: 'CCR-REWRITTEN' }] }
    })
    const agent = agentOf('probe-default-order')
    ctx.permissionRules.setMode(agent, 'auto')

    const result = await ctx.tools.execute(exec('read', { file_path: '/work/x.txt' }, agent))
    expect(texts(result)).toEqual(['CCR-REWRITTEN'])
    const contexts = (result as unknown as { additionalContexts?: { content: ContentBlock[] }[] }).additionalContexts ?? []
    expect(contextTexts(contexts)).toEqual([expect.stringContaining('Security notice')])
    expect(foldProbes(agent.session.snapshotEvents()).at(-1)).toMatchObject({ verdict: 'flag' })
  })

  it('probe fault degrades to passthrough — never an error tool result', async () => {
    const { ctx, llm } = await mount()
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { probe: {} } })
    llm.stream = async function* () { throw new Error('lane exploded') } as never
    const agent = agentOf('probe-fault')
    ctx.permissionRules.setMode(agent, 'auto')

    const result = await ctx.tools.execute(exec('read', { file_path: '/work/x.txt' }, agent))
    expect(result.isError).toBe(false)
    expect(texts(result)).toEqual(['read:/work/x.txt'])
    expect(foldProbes(agent.session.snapshotEvents()).at(-1)).toMatchObject({ verdict: 'pass', failure: 'error' })
  })

  it('non-scan-set tools are never probed even in auto', async () => {
    const { ctx, llm } = await mount()
    ctx.tools.register(defineContentToolFixture({
      name: 'todo_write',
      description: 'todos',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'todos updated' }] },
    }))
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { probe: {} } })
    const agent = agentOf('probe-todo')
    ctx.permissionRules.setMode(agent, 'auto')

    await ctx.tools.execute(exec('todo_write', {}, agent))
    expect(llm.calls).toHaveLength(0)
    expect(foldProbes(agent.session.snapshotEvents())).toHaveLength(0)
  })

  it('toolPatterns REPLACE the default scan set', async () => {
    const { ctx, llm } = await mount()
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { probe: { toolPatterns: ['todo_*'] } } })
    ctx.tools.register(defineContentToolFixture({
      name: 'todo_write',
      description: 'todos',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'todos' }] },
    }))
    const agent = agentOf('probe-patterns')
    ctx.permissionRules.setMode(agent, 'auto')

    await ctx.tools.execute(exec('todo_write', {}, agent))
    expect(llm.calls).toHaveLength(1)
    // ...and a read result is now OUT of the (replaced) scan set.
    const readCalls = llm.calls.length
    await ctx.tools.execute(exec('read', { file_path: '/work/x.txt' }, agent))
    expect(llm.calls).toHaveLength(readCalls)
  })
})
