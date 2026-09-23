import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolExecutionInput } from '@dsh-cc/tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import PermissionRules, {
  PERMISSION_SETTINGS_NAMESPACE,
  appendSessionClassifier,
  appendSessionProbe,
  foldClassifiers,
  foldProbes,
  summarizeChildHandoff,
  type Config,
} from '@dsh-cc/permission-rules'
import type { Agent } from '@deepseek-ai/dsh-agent'

const testToolSignal = new AbortController().signal

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

/**
 * Fake `agents` registry (the one-shot-ledger `ctx.agents.get(id)` face):
 * maps child agent ids to live child agents with full Session objects.
 */
class FakeAgents extends Service {
  children = new Map<string, Agent>()

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  get(id: string): Agent | undefined {
    return this.children.get(id)
  }
}

function childOf(id: string, events: 'none' | 'deny' | 'breaker' | 'asks4' | 'asks5' | 'tripProbeBreaker' = 'none'): Agent {
  const session = Session.create(SessionId(id), undefined, { version: 3, isSeeded: false, id: SessionId(id), createdAt: Date.now(), cwd: '/work' })
  session.append('turn/start', { turn: 1 })
  if (events === 'deny') {
    appendSessionClassifier(session, { tool: 'Bash', digest: 'd', verdict: 'deny', rule: 'hard rule', latencyMs: 1, cacheHit: false })
  } else if (events === 'breaker') {
    appendSessionClassifier(session, { tool: 'Bash', verdict: 'pass', failure: 'breaker', latencyMs: 0, cacheHit: false } as never)
  } else if (events === 'tripProbeBreaker') {
    appendSessionClassifier(session, { tool: 'Bash', verdict: 'ask', failure: 'trip', latencyMs: 0, cacheHit: false })
    appendSessionProbe(session, { tool: 'read', verdict: 'pass', failure: 'breaker', latencyMs: 0 })
  } else if (events === 'asks5' || events === 'asks4') {
    for (let index = 0; index < (events === 'asks5' ? 5 : 4); index += 1) {
      appendSessionClassifier(session, { tool: 'Bash', verdict: 'ask', reason: `r${index}`, latencyMs: 1, cacheHit: false })
    }
  }
  return { id, session, inject: () => {} } as unknown as Agent
}

async function mount(opts: { agents?: boolean } = {}): Promise<{ ctx: Context; llm: FakeLlm; agents: FakeAgents | undefined }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(MemorySettings)
  await ctx.plugin(FakeRoutes)
  await ctx.plugin(FakeLlm)
  if (opts.agents !== false) await ctx.plugin(FakeAgents)
  const llm = ctx.get('llm') as FakeLlm
  await ctx.plugin(PermissionRules, {
    fileEditTools: ['edit'],
    readOnlyTools: ['read'],
    bashToolName: 'Bash',
  } as Config)
  ctx.tools.register(defineTool({
    name: 'subagent_fork',
    description: 'spawn a subagent',
    parameters: { prompt: { type: 'string', required: true }, description: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true }, status: { type: 'string' }, agentId: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
    },
    async execute(args) {
      const child = (ctx.get('agents') as FakeAgents | undefined)
      return Promise.resolve({ text: `report of ${(args as { prompt: string }).prompt}`, status: 'completed', ...(child === undefined ? {} : { agentId: [...child.children.keys()][0] ?? 'child-1' }) })
    },
  }))
  return { ctx, llm, agents: ctx.get('agents') as FakeAgents | undefined }
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

function contextsOf(result: unknown): string[] {
  return contextTexts(((result as { additionalContexts?: { content: ContentBlock[] }[] }).additionalContexts ?? []))
}

describe('S6/D9 arm (a) benches — summarizeChildHandoff (pure fold over fabricated child audit)', () => {
  it('clean child ⇒ no warn', () => {
    expect(summarizeChildHandoff([
      { tool: 'Bash', verdict: 'allow', latencyMs: 1, cacheHit: false },
    ], [])).toEqual({ warn: false, reason: '' })
  })

  it('deny verdict ⇒ warn naming the deny count', () => {
    const out = summarizeChildHandoff([
      { tool: 'Bash', verdict: 'allow', latencyMs: 1, cacheHit: false },
      { tool: 'Bash', verdict: 'deny', rule: 'hard', latencyMs: 1, cacheHit: false },
      { tool: 'Bash', verdict: 'deny', rule: 'hard', latencyMs: 1, cacheHit: false },
    ], [])
    expect(out.warn).toBe(true)
    expect(out.reason).toContain('2')
    expect(out.reason).toContain('denied')
  })

  it('breaker/trip failure ⇒ warn (classifier or probe records both count)', () => {
    expect(summarizeChildHandoff([], [{ tool: 'read', verdict: 'pass', failure: 'breaker', latencyMs: 0 }]).warn).toBe(true)
    expect(summarizeChildHandoff([{ tool: 'Bash', verdict: 'ask', failure: 'trip', latencyMs: 0, cacheHit: false }], []).warn).toBe(true)
  })

  it('ask storm: 5 asks ⇒ warn; EXACTLY 4 asks ⇒ no warn', () => {
    const asks = (count: number) => Array.from({ length: count }, (_, index) => ({ tool: 'Bash', verdict: 'ask' as const, reason: `r${index}`, latencyMs: 1, cacheHit: false }))
    expect(summarizeChildHandoff(asks(5), []).warn).toBe(true)
    expect(summarizeChildHandoff(asks(4), []).warn).toBe(false)
  })
})

describe('S6/D9 return checks (listener integration)', () => {
  it('GATE — child-session resolution: the post-execute path resolves the child via result.value.agentId + the agents registry and folds its audit ⇒ deny ⇒ warn naming the label', async () => {
    const { ctx, agents } = await mount()
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { probe: { enabled: false } } })
    const child = childOf('child-1', 'deny')
    agents!.children.set('child-1', child)
    const agent = agentOf('parent-deny')
    ctx.permissionRules.setMode(agent, 'auto')

    const result = await ctx.tools.execute(exec('subagent_fork', { prompt: 'sweep', description: 'repo sweep' }, agent))
    expect(result.isError).toBe(false)
    const contexts = contextsOf(result)
    expect(contexts.some(text => text.includes('subagent') && text.includes('repo sweep') && text.includes('denied'))).toBe(true)
  })

  it('clean child ⇒ no warning, results untouched', async () => {
    const { ctx, agents } = await mount()
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { probe: { enabled: false } } })
    agents!.children.set('child-1', childOf('child-1', 'asks4'))
    const agent = agentOf('parent-clean')
    ctx.permissionRules.setMode(agent, 'auto')

    const result = await ctx.tools.execute(exec('subagent_fork', { prompt: 'sweep', description: 'sweep' }, agent))
    expect(result.isError).toBe(false)
    expect(contextsOf(result)).toEqual([])
    expect(foldClassifiers(agent.session.snapshotEvents())).toHaveLength(0)
  })

  it('5-ask storm ⇒ warn; breaker/trip ⇒ warn', async () => {
    const { ctx, agents } = await mount()
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { probe: { enabled: false } } })
    agents!.children.set('child-1', childOf('child-1', 'asks5'))
    const agent = agentOf('parent-storm')
    ctx.permissionRules.setMode(agent, 'auto')

    const contexts = contextsOf(await ctx.tools.execute(exec('subagent_fork', { prompt: 'sweep', description: 'sweep' }, agent)))
    expect(contexts.some(text => text.includes('5') && text.includes('escalat'))).toBe(true)

    agents!.children.set('child-2', childOf('child-2', 'tripProbeBreaker'))
    const result2 = await ctx.tools.execute(exec('subagent_fork', { prompt: 's2', description: 'second' }, agent))
    expect(contextsOf(result2).some(text => text.includes('second'))).toBe(true)
  })

  it('a child the resolver cannot find ⇒ no fabricated warning; a resolver that THROWS ⇒ debug note only', async () => {
    const { ctx, agents } = await mount()
    const debug = vi.fn()
    ;(ctx.logger as { debug?: (message: string) => void }).debug = debug
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { probe: { enabled: false } } })
    const agent = agentOf('parent-orphan')
    ctx.permissionRules.setMode(agent, 'auto')

    // No resolvable child: unresolvable, no warning, no debug noise.
    const result = await ctx.tools.execute(exec('subagent_fork', { prompt: 'sweep', description: 'sweep' }, agent))
    expect(contextsOf(result)).toEqual([])
    expect(debug).not.toHaveBeenCalled()

    // Resolver throws: debug note, never a fabricated warning.
    const throwing = vi.spyOn(agents as unknown as { get: (id: string) => unknown }, 'get')
      .mockImplementation(() => { throw new Error('registry exploded') })
    const result2 = await ctx.tools.execute(exec('subagent_fork', { prompt: 'sweep2', description: 's2' }, agent))
    expect(contextsOf(result2)).toEqual([])
    expect(debug.mock.calls.some(args => args.join(' ').includes('registry exploded'))).toBe(true)
    throwing.mockRestore()
  })

  it('ARM (b) — the returned report text is screened through the S7 probe machinery: flag ⇒ suspect-report warning via additionalContexts', async () => {
    const { ctx, llm, agents } = await mount()
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { probe: { enabled: true } } })
    agents!.children.set('child-1', childOf('child-1', 'none'))
    llm.scripted = ['{"injection":true,"reason":"report tries to override instructions"}']
    const agent = agentOf('parent-flag')
    ctx.permissionRules.setMode(agent, 'auto')

    const result = await ctx.tools.execute(exec('subagent_fork', { prompt: 'sweep', description: 'sweep' }, agent))
    expect(result.isError).toBe(false)
    const contexts = contextsOf(result)
    expect(contexts.some(text => text.includes('Security notice') && text.includes('re-anchor'))).toBe(true)
    const folded = foldProbes(agent.session.snapshotEvents())
    expect(folded.at(-1)).toMatchObject({ tool: 'subagent_fork', verdict: 'flag', reason: 'report tries to override instructions' })
  })

  it('ARM (b) — clean report ⇒ no warning (probe runs, verdict pass)', async () => {
    const { ctx, llm, agents } = await mount()
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { probe: { enabled: true } } })
    agents!.children.set('child-1', childOf('child-1', 'none'))
    const agent = agentOf('parent-cleanprobe')
    ctx.permissionRules.setMode(agent, 'auto')

    const result = await ctx.tools.execute(exec('subagent_fork', { prompt: 'sweep', description: 'sweep' }, agent))
    expect(contextsOf(result)).toEqual([])
    expect(llm.calls).toHaveLength(1) // the probe lane ran once
    expect(foldProbes(agent.session.snapshotEvents()).at(-1)).toMatchObject({ verdict: 'pass' })
  })

  it('ordering: a CCR-style content-replacing listener cannot drop the return-check warning (sideband survives)', async () => {
    const { ctx, llm, agents } = await mount()
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { probe: { enabled: true } } })
    agents!.children.set('child-1', childOf('child-1', 'none'))
    llm.scripted = ['{"injection":true,"reason":"bad report"}']
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      const d = await next()
      if (d.kind !== 'accept') return d
      return { ...d, content: [{ type: 'text', text: 'CCR-REWRITTEN' }] }
    })
    const agent = agentOf('parent-ccr')
    ctx.permissionRules.setMode(agent, 'auto')

    const result = await ctx.tools.execute(exec('subagent_fork', { prompt: 'sweep', description: 'sweep' }, agent))
    expect(contextsOf(result).some(text => text.includes('Security notice'))).toBe(true)
  })

  it('mode gate: outside auto, NEITHER arm runs (no probe call, no child warning)', async () => {
    const { ctx, llm, agents } = await mount()
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { probe: { enabled: true } } })
    agents!.children.set('child-1', childOf('child-1', 'deny'))
    const agent = agentOf('parent-default')
    ctx.permissionRules.setMode(agent, 'default')

    const result = await ctx.tools.execute(exec('subagent_fork', { prompt: 'sweep', description: 'sweep' }, agent))
    expect(llm.calls).toHaveLength(0)
    expect(contextsOf(result)).toEqual([])
  })
})
