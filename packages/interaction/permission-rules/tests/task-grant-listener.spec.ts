import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type ToolExecutionInput, type ToolExecutionResult } from '@dsh-cc/tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { SettingsProvider, type SettingsNamespace } from '@dsh-cc/settings-provider'
import PermissionRules, { PERMISSION_SETTINGS_NAMESPACE, foldClassifiers, type Config } from '@dsh-cc/permission-rules'
import type { Agent } from '@deepseek-ai/dsh-agent'

const testToolSignal = new AbortController().signal

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

/** Fake `llm` service: records stream calls, emits one scripted verdict. */
class FakeLlm extends Service {
  calls: GenerateOptions[] = []

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield { type: 'text-delta', index: 0, text: '{"verdict":"ask","reason":"arbitrate"}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class FakeRoutes extends Service {
  constructor(ctx: Context) {
    super(ctx, 'ccModelRoutes')
  }

  resolve(): { provider: string; model: string } {
    return { provider: 'fake', model: 'classifier-model' }
  }

  resolveDetailed(): { selector: string; via: 'alias'; route: { provider: string; model: string } } {
    return { selector: 'classifier-model', via: 'alias', route: this.resolve() }
  }
}

async function mount(config: Config = {}): Promise<{ ctx: Context; llm: FakeLlm }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(MemorySettings)
  await ctx.plugin(FakeRoutes)
  await ctx.plugin(FakeLlm)
  const llm = ctx.get('llm') as FakeLlm
  await ctx.plugin(PermissionRules, { fileEditTools: ['edit'], readOnlyTools: ['read'], bashToolName: 'Bash', ...config })
  ctx.tools.register(defineContentToolFixture({
    name: 'Bash',
    description: 'shell',
    parameters: { command: { type: 'string' } },
    async execute(args) { return [{ type: 'text', text: `ran:${(args as { command: string }).command}` }] },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'edit',
    description: 'edit',
    parameters: { file_path: { type: 'string' } },
    async execute(args) { return [{ type: 'text', text: `edited:${(args as { file_path: string }).file_path}` }] },
  }))
  return { ctx, llm }
}

function workspaceWithDescriptor(descriptor: Record<string, unknown>): { root: string; descriptorPath: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grant-listener-')))
  const descriptorPath = join(root, 'grant-descriptor.json')
  writeFileSync(descriptorPath, JSON.stringify(descriptor), 'utf8')
  mkdirSync(join(root, 'docs'), { recursive: true })
  return { root, descriptorPath }
}

function exec(name: string, args: unknown, agent?: Agent): ToolExecutionInput {
  return { signal: testToolSignal, callId: ToolCallId('c1'), name, arguments: args, ...(agent ? { agent } : {}) }
}

function text(result: ToolExecutionResult): string {
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

function agentOf(id: string, cwd: string): Agent {
  const session = Session.create(SessionId(id), undefined, {
    version: 4, isSeeded: false, id: SessionId(id), createdAt: Date.now(), cwd,
  })
  session.append('turn/start', { turn: 1 })
  return { id, session, inject: () => {} } as unknown as Agent
}

/** Classifier-lane calls only (the probe lane shares the fake llm). */
function classifierCalls(llm: FakeLlm): GenerateOptions[] {
  return llm.calls.filter(call => call.maxTokens === 1024)
}

describe('task grant on the pre-execute chain (§3.4 placement)', () => {
  it('a grant hit allows deterministically BEFORE LLM arbitration; a miss still arbitrates', async () => {
    const { ctx, llm } = await mount()
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { classifier: { enabled: true } } })
    const asked: unknown[] = []
    ctx.on('approval/request', async (req) => { asked.push(req); return 'allowed-once' })
    const { root, descriptorPath } = workspaceWithDescriptor({
      rules: ['Bash(git status)', 'Bash(echo ok)'],
      tools: ['argument.*'],
      writePaths: ['docs/'],
      sandboxEscalation: false,
    })
    const agent = agentOf('grant-placement', root)
    ctx.permissionRules.setMode(agent, 'auto')
    await ctx.permissionRules.grants.propose(agent, descriptorPath)
    await ctx.permissionRules.grants.create(agent, descriptorPath)

    const hit = await ctx.tools.execute(exec('Bash', { command: 'echo ok' }, agent))
    expect(hit.isError).toBe(false)
    expect(text(hit)).toBe('ran:echo ok')
    // Deterministic allow: no arbitration ran and nothing was asked.
    expect(classifierCalls(llm)).toHaveLength(0)
    expect(asked).toHaveLength(0)

    const miss = await ctx.tools.execute(exec('Bash', { command: 'rm -rf build' }, agent))
    expect(miss.isError).toBe(false)
    expect(classifierCalls(llm).length).toBeGreaterThan(0)
    expect(foldClassifiers(agent.session.snapshotEvents())).toHaveLength(1)
  })

  it('grant writePaths allow an edit under the granted path only', async () => {
    const { ctx, llm } = await mount()
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { classifier: { enabled: true } } })
    // Nothing else answers: any non-granted write falls through the waterfall,
    // reaches arbitration and is rejected.
    ctx.on('approval/request', async () => 'rejected')
    const { root, descriptorPath } = workspaceWithDescriptor({
      rules: [], tools: [], writePaths: ['docs/'], sandboxEscalation: false,
    })
    const agent = agentOf('grant-write', root)
    ctx.permissionRules.setMode(agent, 'auto')
    await ctx.permissionRules.grants.propose(agent, descriptorPath)
    await ctx.permissionRules.grants.create(agent, descriptorPath)
    const inside = await ctx.tools.execute(exec('edit', { file_path: join(root, 'docs/a.md') }, agent))
    expect(inside.isError).toBe(false)
    expect(classifierCalls(llm)).toHaveLength(0)
    const outside = await ctx.tools.execute(exec('edit', { file_path: join(root, 'src/a.ts') }, agent))
    expect(outside.isError).toBe(true)
    expect(classifierCalls(llm).length).toBeGreaterThan(0)
  })

  it('create/list/revoke lifecycle through the service (§3.3)', async () => {
    const { ctx, llm } = await mount()
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { classifier: { enabled: true } } })
    ctx.on('approval/request', async () => 'rejected')
    const { root, descriptorPath } = workspaceWithDescriptor({
      rules: ['Bash(echo ok)'], tools: [], writePaths: [], sandboxEscalation: false,
    })
    const agent = agentOf('grant-lifecycle', root)
    ctx.permissionRules.setMode(agent, 'auto')
    await ctx.permissionRules.grants.propose(agent, descriptorPath)
    const grant = await ctx.permissionRules.grants.create(agent, descriptorPath)
    expect(grant.createdBy).toBe('user')
    expect(grant.root).toBe(root)
    expect(ctx.permissionRules.grants.of(agent).map(entry => entry.grantId)).toEqual([grant.grantId])

    const before = await ctx.tools.execute(exec('Bash', { command: 'echo ok' }, agent))
    expect(before.isError).toBe(false)
    expect(classifierCalls(llm)).toHaveLength(0)

    expect(ctx.permissionRules.grants.revoke(agent, 'grant_missing')).toBe(false)
    expect(ctx.permissionRules.grants.revoke(agent, grant.grantId)).toBe(true)
    expect(ctx.permissionRules.grants.of(agent)).toHaveLength(0)
    // A revoked grant no longer admits anything: the call now reaches arbitration.
    const after = await ctx.tools.execute(exec('Bash', { command: 'echo ok' }, agent))
    expect(after.isError).toBe(true)
    expect(classifierCalls(llm).length).toBeGreaterThan(0)
  })

  it('a descriptor that declares VWA state as writable is rejected at creation', async () => {
    const { ctx } = await mount()
    const { root, descriptorPath } = workspaceWithDescriptor({
      rules: [], tools: [], writePaths: ['.dsh/vwa/prj_1/adjudications.json'], sandboxEscalation: false,
    })
    const agent = agentOf('grant-reject', root)
    await expect(ctx.permissionRules.grants.propose(agent, descriptorPath)).rejects.toThrow(/authoritative VWA state/)
    expect(ctx.permissionRules.grants.of(agent)).toHaveLength(0)
  })

  it('P1b: confirm is bound to the descriptor content shown at view time', async () => {
    const { ctx } = await mount()
    const { root, descriptorPath } = workspaceWithDescriptor({
      rules: ['Bash(echo ok)'], tools: [], writePaths: [], sandboxEscalation: false,
    })
    const agent = agentOf('grant-toctou', root)
    const view = await ctx.permissionRules.grants.propose(agent, descriptorPath)
    expect(view.rules).toEqual(['Bash(echo ok)'])
    // The agent rewrites the descriptor between the view and `--confirm`.
    writeFileSync(descriptorPath, JSON.stringify({
      rules: ['Bash(rm -rf /)'], tools: [], writePaths: [], sandboxEscalation: false,
    }), 'utf8')
    await expect(ctx.permissionRules.grants.create(agent, descriptorPath)).rejects.toThrow(/changed since the approval view/)
    expect(ctx.permissionRules.grants.of(agent)).toHaveLength(0)
  })

  it('P1b: create without a reviewed view is rejected', async () => {
    const { ctx } = await mount()
    const { root, descriptorPath } = workspaceWithDescriptor({
      rules: ['Bash(echo ok)'], tools: [], writePaths: [], sandboxEscalation: false,
    })
    const agent = agentOf('grant-no-view', root)
    await expect(ctx.permissionRules.grants.create(agent, descriptorPath)).rejects.toThrow(/no proposed grant is pending/)
    expect(ctx.permissionRules.grants.of(agent)).toHaveLength(0)
  })
})
