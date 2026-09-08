import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type ToolExecutionInput, type ToolExecutionResult } from '@dsh-cc/tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import PermissionRules, { PERMISSION_SETTINGS_NAMESPACE, CLASSIFIER_EVENT, foldClassifiers, type Config } from '@dsh-cc/permission-rules'
import type { Agent } from '@deepseek-ai/dsh-agent'

const testToolSignal = new AbortController().signal

/** Minimal in-memory settings provider (same pattern as permission-rules.spec.ts). */
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

/** Fake `llm` service: records stream calls, emits one scripted text verdict. */
class FakeLlm extends Service {
  calls: GenerateOptions[] = []
  scripted: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield { type: 'text-delta', index: 0, text: this.scripted.shift() ?? '{"verdict":"allow","reason":"ok"}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Fake `ccModelRoutes` service: resolves every alias to a deterministic fake route. */
class FakeRoutes extends Service {
  constructor(ctx: Context) {
    super(ctx, 'ccModelRoutes')
  }

  resolve(): { provider: string; model: string } {
    return { provider: 'fake', model: 'classifier-model' }
  }
}

async function mount(config: Config = {}, opts: { routes?: boolean } = {}): Promise<{ ctx: Context; llm: FakeLlm }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(MemorySettings)
  if (opts.routes !== false) await ctx.plugin(FakeRoutes)
  await ctx.plugin(FakeLlm)
  const llm = ctx.get('llm') as FakeLlm
  await ctx.plugin(PermissionRules, {
    fileEditTools: ['edit'],
    readOnlyTools: ['read'],
    bashToolName: 'Bash',
    ...config,
  })
  ctx.tools.register(defineContentToolFixture({
    name: 'Bash',
    description: 'shell',
    parameters: { command: { type: 'string' } },
    async execute(args) { return [{ type: 'text', text: `ran:${(args as { command: string }).command}` }] },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'edit',
    description: 'edit file',
    parameters: { file_path: { type: 'string' } },
    async execute(args) { return [{ type: 'text', text: `edited:${(args as { file_path: string }).file_path}` }] },
  }))
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

function text(result: ToolExecutionResult): string {
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

function agentOf(id: string, cwd = '/work'): Agent {
  const session = Session.create(SessionId(id), undefined, { version: 0, isSeeded: false, id: SessionId(id), createdAt: Date.now(), cwd })
  session.append('turn/start', { turn: 1 })
  return { id, session, inject: () => {} } as unknown as Agent
}

async function arm(ctx: Context, autoMode: Record<string, unknown> = { classifier: { enabled: true } }): Promise<void> {
  await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode })
}

describe('listener × LLM classifier stage (integration)', () => {
  it('armed + auto + LOW + rule ask: classifier allow lets the call run without a prompt; audit event appended', async () => {
    const { ctx, llm } = await mount()
    await arm(ctx)
    const asked: unknown[] = []
    ctx.on('approval/request', async (req) => { asked.push(req); return 'allowed-once' })
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { ask: ['Bash'], autoMode: { classifier: { enabled: true } } })
    const agent = agentOf('int-allow')
    ctx.permissionRules.setMode(agent, 'auto')

    const result = await ctx.tools.execute(exec('Bash', { command: 'ls -la' }, agent))
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('ran:ls -la')
    expect(asked).toHaveLength(0)
    expect(llm.calls).toHaveLength(1)
    const folded = foldClassifiers(agent.session.snapshotEvents())
    expect(folded).toHaveLength(1)
    expect(folded[0]).toMatchObject({ tool: 'Bash', verdict: 'allow', provider: 'fake', model: 'classifier-model' })
  })

  it('armed + verdict ask: the call prompts with the classifier reason', async () => {
    const { ctx, llm } = await mount()
    await arm(ctx)
    const reasons: string[] = []
    ctx.on('approval/request', async (req) => {
      reasons.push(String((req as { reason?: string }).reason ?? ''))
      return 'allowed-once'
    })
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { ask: ['Bash'], autoMode: { classifier: { enabled: true } } })
    llm.scripted = ['{"verdict":"ask","reason":"terraform apply on prod"}']
    const agent = agentOf('int-ask')
    ctx.permissionRules.setMode(agent, 'auto')

    await ctx.tools.execute(exec('Bash', { command: 'ls' }, agent))
    expect(reasons[0]).toContain('terraform apply on prod')
    expect(llm.calls).toHaveLength(1)
    expect(foldClassifiers(agent.session.snapshotEvents())[0]).toMatchObject({ verdict: 'ask' })
  })

  it('disarmed (enabled absent): identical legacy mapping — auto+LOW+ask proxies to allow, LLM never called', async () => {
    const { ctx, llm } = await mount()
    const asked: unknown[] = []
    ctx.on('approval/request', async (req) => { asked.push(req); return 'allowed-once' })
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { ask: ['Bash'] })
    const agent = agentOf('int-legacy')
    ctx.permissionRules.setMode(agent, 'auto')
    const result = await ctx.tools.execute(exec('Bash', { command: 'ls' }, agent))
    expect(result.isError).toBe(false)
    expect(asked).toHaveLength(0)
    expect(llm.calls).toHaveLength(0)
  })

  it('I1/I2/I3: HIGH deny, rule deny, and plan mode never consult the LLM even when armed', async () => {
    const { ctx, llm } = await mount()
    await arm(ctx)
    ctx.on('approval/request', async () => 'allowed-once')
    // I2: whole-tool deny rule.
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { deny: ['Bash'], autoMode: { classifier: { enabled: true } } })
    const agent = agentOf('int-deny')
    ctx.permissionRules.setMode(agent, 'auto')
    const denied = await ctx.tools.execute(exec('Bash', { command: 'ls' }, agent))
    expect(denied.isError).toBe(true)

    // I3: plan mode wrap (read-only tool) — no LLM even though armed.
    const planAgent = agentOf('int-plan')
    planAgent.session.append('plan/mode', { active: true })
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { classifier: { enabled: true } } })
    const planResult = await ctx.tools.execute(exec('read', { file_path: '/work/x.ts' }, planAgent))
    expect(planResult.isError).toBe(false)
    expect(text(planResult)).toBe('read:/work/x.ts')

    // I1: catastrophic bash — HIGH deny, no LLM.
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { classifier: { enabled: true } } })
    const agent2 = agentOf('int-high')
    const high = await ctx.tools.execute(exec('Bash', { command: 'rm -rf /' }, agent2))
    expect(high.isError).toBe(true)
    expect(llm.calls).toHaveLength(0)
    // I5: MEDIUM (out-of-scope write) behaves unchanged — asks, LLM not consulted.
    const mediumAgent = agentOf('int-medium')
    ctx.permissionRules.setMode(mediumAgent, 'auto')
    const medium = await ctx.tools.execute(exec('edit', { file_path: '/outside/x.txt' }, mediumAgent))
    expect(medium.isError).toBe(false) // approval listener allowed-once path
    expect(llm.calls).toHaveLength(0)
  })

  it('enabled but route unresolvable: warns once, legacy path, unarmed audit event', async () => {
    // No model route service and no settings overlay ⇒ haiku unresolvable.
    const { ctx } = await mount({}, { routes: false })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const asked: unknown[] = []
    ctx.on('approval/request', async (req) => { asked.push(req); return 'allowed-once' })
    // No model-aliases overlay ⇒ haiku unresolvable.
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { ask: ['Bash'], autoMode: { classifier: { enabled: true } } })
    const agent = agentOf('int-unarmed')
    ctx.permissionRules.setMode(agent, 'auto')
    const first = await ctx.tools.execute(exec('Bash', { command: 'ls' }, agent))
    const second = await ctx.tools.execute(exec('Bash', { command: 'ls' }, agent))
    expect(first.isError).toBe(false)
    expect(second.isError).toBe(false)
    expect(asked).toHaveLength(0) // legacy auto-proxy ran both times
    const warns = warn.mock.calls.filter(call => String(call[0]).match(/classifier/i))
    expect(warns).toHaveLength(1)
    const folded = foldClassifiers(agent.session.snapshotEvents())
    expect(folded).toHaveLength(2)
    expect(folded.every(record => record.failure === 'unarmed')).toBe(true)
  })

  it('classify failures (timeout/error/malformed) fail to ask, never silently allow', async () => {
    const { ctx, llm } = await mount()
    await arm(ctx)
    const reasons: string[] = []
    ctx.on('approval/request', async (req) => { reasons.push(String((req as { reason?: string }).reason ?? '')); return 'allowed-once' })
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { ask: ['Bash'], autoMode: { classifier: { enabled: true } } })
    llm.scripted = ['garbage }}']
    const agent = agentOf('int-malformed')
    ctx.permissionRules.setMode(agent, 'auto')
    await ctx.tools.execute(exec('Bash', { command: 'ls' }, agent))
    expect(reasons[0]).toMatch(/unparseable/)
    const folded = foldClassifiers(agent.session.snapshotEvents())
    expect(folded[0]?.failure).toBe('malformed')
  })

  it('the armed classifier memoizes: two identical calls hit the cache (one stream call), settings change rebuilds', async () => {
    const { ctx, llm } = await mount()
    await arm(ctx)
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { ask: ['Bash'], autoMode: { classifier: { enabled: true } } })
    const agent = agentOf('int-cache')
    ctx.permissionRules.setMode(agent, 'auto')
    await ctx.tools.execute(exec('Bash', { command: 'ls' }, agent))
    await ctx.tools.execute(exec('Bash', { command: 'ls' }, agent))
    expect(llm.calls).toHaveLength(1)
  })
})
