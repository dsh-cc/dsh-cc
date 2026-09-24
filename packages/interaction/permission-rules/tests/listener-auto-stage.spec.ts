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
  /** Optional catalog face consumed by the classifier effort adapter. */
  reasoning?: { efforts: readonly { id: string }[] }

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield { type: 'text-delta', index: 0, text: this.scripted.shift() ?? '{"verdict":"allow","reason":"ok"}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  infoCalls = 0

  async resolveModelInfo(): Promise<{ reasoning?: { efforts: readonly { id: string }[] } }> {
    this.infoCalls += 1
    return this.reasoning === undefined ? {} : { reasoning: this.reasoning }
  }
}

/** Fake `ccModelRoutes` service: resolves every alias to a deterministic fake route. */
class FakeRoutes extends Service {
  /** Configurable resolved route (may carry an explicit reasoningEffort). */
  route: { provider: string; model: string; reasoningEffort?: string } = { provider: 'fake', model: 'classifier-model' }

  constructor(ctx: Context) {
    super(ctx, 'ccModelRoutes')
  }

  resolve(): { provider: string; model: string; reasoningEffort?: string } {
    return this.route
  }

  resolveDetailed(): { selector: string; via: 'alias'; route: { provider: string; model: string } } {
    return { selector: 'classifier-model', via: 'alias', route: this.resolve() }
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

/**
 * Classifier-lane calls only: S7 adds an independent auto-mode probe lane
 * (maxTokens 256) that shares the FakeLlm in integration tests.
 */
function classifierCalls(llm: FakeLlm): GenerateOptions[] {
  return llm.calls.filter(call => call.maxTokens === 1024)
}

function text(result: ToolExecutionResult): string {
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

function agentOf(id: string, cwd = '/work'): Agent {
  const session = Session.create(SessionId(id), undefined, { version: 3, isSeeded: false, id: SessionId(id), createdAt: Date.now(), cwd })
  session.append('turn/start', { turn: 1 })
  return { id, session, inject: () => {} } as unknown as Agent
}

async function arm(ctx: Context, autoMode: Record<string, unknown> = { classifier: { enabled: true } }): Promise<void> {
  await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode })
}

describe('listener × LLM classifier stage (integration)', () => {
  it('armed + auto + LOW + passthrough: classifier allow lets the call run without a prompt; audit event appended (D3: eligibility is passthrough-only)', async () => {
    const { ctx, llm } = await mount()
    await arm(ctx)
    const asked: unknown[] = []
    ctx.on('approval/request', async (req) => { asked.push(req); return 'allowed-once' })
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { classifier: { enabled: true } } })
    const agent = agentOf('int-allow')
    ctx.permissionRules.setMode(agent, 'auto')

    const result = await ctx.tools.execute(exec('Bash', { command: 'ls -la' }, agent))
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('ran:ls -la')
    expect(asked).toHaveLength(0)
    expect(classifierCalls(llm)).toHaveLength(1)
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
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { classifier: { enabled: true } } })
    llm.scripted = ['{"verdict":"ask","reason":"terraform apply on prod"}']
    const agent = agentOf('int-ask')
    ctx.permissionRules.setMode(agent, 'auto')

    await ctx.tools.execute(exec('Bash', { command: 'ls' }, agent))
    expect(reasons[0]).toContain('terraform apply on prod')
    expect(classifierCalls(llm)).toHaveLength(1)
    expect(foldClassifiers(agent.session.snapshotEvents())[0]).toMatchObject({ verdict: 'ask' })
  })

  it('disarmed + auto + suspended Bash(*) allow + LOW curl: rule suspended (D1), passthrough flows downstream to allow', async () => {
    const { ctx, llm } = await mount()
    const asked: unknown[] = []
    ctx.on('approval/request', async (req) => { asked.push(req); return 'allowed-once' })
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { allow: ['Bash(*)'] })
    const agent = agentOf('int-suspend')
    ctx.permissionRules.setMode(agent, 'auto')
    const result = await ctx.tools.execute(exec('Bash', { command: 'curl https://example.com' }, agent))
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('ran:curl https://example.com')
    expect(asked).toHaveLength(0)
    expect(classifierCalls(llm)).toHaveLength(0)
  })

  it('disarmed: F1 proxy REMOVED (design doc D3) — auto + rule ask prompts; LLM never called', async () => {
    const { ctx, llm } = await mount()
    const asked: unknown[] = []
    ctx.on('approval/request', async (req) => { asked.push(req); return 'allowed-once' })
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { ask: ['Bash'] })
    const agent = agentOf('int-legacy')
    ctx.permissionRules.setMode(agent, 'auto')
    const result = await ctx.tools.execute(exec('Bash', { command: 'ls' }, agent))
    // Strict-rule auto (D11/D3): the ask rule now PROMPTS — no allow proxy.
    expect(asked).toHaveLength(1)
    expect(result.isError).toBe(false)
    expect(classifierCalls(llm)).toHaveLength(0)
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
    expect(classifierCalls(llm)).toHaveLength(0)
    // I5 (S3 flip): MEDIUM (out-of-scope write) + passthrough + armed ⇒ the
    // LLM arbitrates (one call); the ask verdict prompts via the approval seam.
    const mediumAgent = agentOf('int-medium')
    ctx.permissionRules.setMode(mediumAgent, 'auto')
    const medium = await ctx.tools.execute(exec('edit', { file_path: '/outside/x.txt' }, mediumAgent))
    expect(medium.isError).toBe(false) // approval listener allowed-once path
    expect(classifierCalls(llm)).toHaveLength(1)
  })

  it('enabled but route unresolvable: warns once, D11 fail-to-PROMPT (ask with availability reason), unarmed audit event', async () => {
    // No model route service and no settings overlay ⇒ haiku unresolvable.
    const { ctx } = await mount({}, { routes: false })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const reasons: string[] = []
    ctx.on('approval/request', async (req) => { reasons.push(String((req as { reason?: string }).reason ?? '')); return 'allowed-once' })
    // No model-aliases overlay ⇒ haiku unresolvable.
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { classifier: { enabled: true } } })
    const agent = agentOf('int-unarmed')
    ctx.permissionRules.setMode(agent, 'auto')
    const first = await ctx.tools.execute(exec('Bash', { command: 'ls' }, agent))
    const second = await ctx.tools.execute(exec('Bash', { command: 'ls' }, agent))
    // D11 (S3): an ELIGIBLE (auto+passthrough+LOW) call fails to PROMPT with
    // an availability reason — never a silent downstream allow.
    expect(first.isError).toBe(false)
    expect(second.isError).toBe(false)
    expect(reasons).toHaveLength(2)
    expect(reasons.every(reason => /unavailable/i.test(reason))).toBe(true)
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
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { classifier: { enabled: true } } })
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
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { classifier: { enabled: true } } })
    const agent = agentOf('int-cache')
    ctx.permissionRules.setMode(agent, 'auto')
    await ctx.tools.execute(exec('Bash', { command: 'ls' }, agent))
    await ctx.tools.execute(exec('Bash', { command: 'ls' }, agent))
    expect(classifierCalls(llm)).toHaveLength(1)
  })
})

describe('listener × classifier effort adapter (integration)', () => {
  async function armedMount() {
    const mounted = await mount()
    const { ctx, llm } = mounted
    const routes = ctx.get('ccModelRoutes') as FakeRoutes
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { classifier: { enabled: true } } })
    const agent = agentOf('int-effort')
    ctx.permissionRules.setMode(agent, 'auto')
    return { ctx, llm, routes, warn, agent, run: (cmd = 'ls') => ctx.tools.execute(exec('Bash', { command: cmd }, agent)) }
  }

  it('catalog with levels and no explicit route effort: the FIRST declared level is passed', async () => {
    const { llm, run } = await armedMount()
    llm.reasoning = { efforts: [{ id: 'low' }, { id: 'high' }] }
    await run()
    expect(classifierCalls(llm)).toHaveLength(1)
    expect(llm.calls[0]?.reasoningEffort).toBe('low')
  })

  it('route explicit member effort: passed through', async () => {
    const { llm, routes, run } = await armedMount()
    routes.route = { provider: 'fake', model: 'classifier-model', reasoningEffort: 'high' }
    llm.reasoning = { efforts: [{ id: 'low' }, { id: 'high' }] }
    await run()
    expect(llm.calls[0]?.reasoningEffort).toBe('high')
  })

  it('route explicit NON-member effort: warn once + omitted (never throws, never silent)', async () => {
    const { llm, routes, warn, run } = await armedMount()
    routes.route = { provider: 'fake', model: 'classifier-model', reasoningEffort: 'ultra' }
    llm.reasoning = { efforts: [{ id: 'low' }] }
    await run()
    expect(llm.calls[0]?.reasoningEffort).toBeUndefined()
    expect(warn.mock.calls.some(call => String(call[0]).includes('ultra'))).toBe(true)
  })

  it('catalog with no efforts: omitted', async () => {
    const { llm, run } = await armedMount()
    llm.reasoning = { efforts: [] }
    await run()
    expect(llm.calls[0]?.reasoningEffort).toBeUndefined()
  })

  it('resolveModelInfo throws: omitted, one warn, classification still runs', async () => {
    const { llm, warn, run } = await armedMount()
    llm.resolveModelInfo = async () => { throw new Error('catalog down') }
    await run()
    expect(classifierCalls(llm)).toHaveLength(1)
    expect(classifierCalls(llm)[0]?.reasoningEffort).toBeUndefined()
    expect(warn.mock.calls.some(call => String(call[0]).includes('route info'))).toBe(true)
  })

  it('memoized per route key: resolveModelInfo hit once across two calls', async () => {
    const { llm, run } = await armedMount()
    llm.reasoning = { efforts: [{ id: 'low' }] }
    await run()
    await run('git push')
    expect(classifierCalls(llm)).toHaveLength(2)
    expect(llm.infoCalls).toBe(1)
  })
})
