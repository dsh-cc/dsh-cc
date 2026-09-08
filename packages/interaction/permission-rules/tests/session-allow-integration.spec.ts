import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type ToolExecutionInput, type ToolExecutionResult } from '@dsh-cc/tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import PermissionRules, { SESSION_ALLOW_EVENT, type Config } from '@dsh-cc/permission-rules'
import type { Agent } from '@deepseek-ai/dsh-agent'

const testToolSignal = new AbortController().signal

/**
 * Mount the plugin exactly like permission-rules.spec.ts, with the settings
 * provider observed so the specs can prove session-scoped grants never write
 * to global settings.
 */
async function mount(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
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
  return ctx
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

function agentWithCwd(id: string, cwd: string): Agent {
  const session = Session.create(SessionId(id), undefined, {
    version: 0,
    isSeeded: false,
    id: SessionId(id),
    createdAt: Date.now(),
    cwd,
  })
  session.append('turn/start', { turn: 1 })
  return { id, session, inject: () => {} } as unknown as Agent
}

describe('session allowlist × decide() integration', () => {
  it('a session grant lets a MEDIUM (out-of-scope) write run without asking', async () => {
    const ctx = await mount()
    const agent = agentWithCwd('session-allow-1', '/work')
    const asked: unknown[] = []
    ctx.on('approval/request', async req => { asked.push(req); return 'allowed-once' })

    const askedOnce = await ctx.tools.execute(exec('edit', { file_path: '/outside/x.txt' }, agent))
    // The ask routes to the approval listener, which grants once — the call
    // runs, but the ask demonstrably fired.
    expect(askedOnce.isError).toBe(false)
    expect(text(askedOnce)).toBe('edited:/outside/x.txt')
    expect(asked).toHaveLength(1)

    // Grant the whole-tool rule for this session: the next MEDIUM call runs.
    ctx.permissionRules.addSessionAllow(agent, 'edit')
    const allowed = await ctx.tools.execute(exec('edit', { file_path: '/outside/y.txt' }, agent))
    expect(allowed.isError).toBe(false)
    expect(text(allowed)).toBe('edited:/outside/y.txt')
    expect(asked).toHaveLength(1)
  })

  it('the session grant is audited and never persisted to global settings', async () => {
    const ctx = await mount()
    const agent = agentWithCwd('session-allow-2', '/work')
    ctx.on('approval/request', async () => 'allowed-once')
    ctx.permissionRules.addSessionAllow(agent, 'Bash(npm )')

    const event = agent.session.snapshotEvents()[agent.session.seq - 1] as unknown as {
      type: string
      data: Record<string, unknown>
    }
    expect(event.type).toBe(SESSION_ALLOW_EVENT)
    expect(event.data.rule).toBe('Bash(npm )')
    expect(event.data.scope).toBe('session')

    // The settings document was never touched: the plugin has no settings
    // provider mounted and addSessionAllow returns without consulting one.
    const settings = ctx.get('settings') as { describe?: () => unknown } | undefined
    expect(settings === undefined || settings.describe === undefined).toBe(true)
  })

  it('HIGH (protected file) stays denied even with a session grant', async () => {
    const ctx = await mount()
    const agent = agentWithCwd('session-allow-3', '/work')
    ctx.on('approval/request', async () => 'allowed-once')
    ctx.permissionRules.addSessionAllow(agent, 'edit')
    const result = await ctx.tools.execute(exec('edit', { file_path: '/work/.bashrc' }, agent))
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/risk classifier/)
  })

  it('clearing the session allowlist restores the ask', async () => {
    const ctx = await mount()
    const agent = agentWithCwd('session-allow-4', '/work')
    const asked: unknown[] = []
    ctx.on('approval/request', async req => { asked.push(req); return 'allowed-once' })
    ctx.permissionRules.addSessionAllow(agent, 'edit')
    ctx.permissionRules.clearSessionAllows(agent)

    const result = await ctx.tools.execute(exec('edit', { file_path: '/outside/x.txt' }, agent))
    expect(result.isError).toBe(false)
    expect(asked).toHaveLength(1)
  })

  it('another session gains nothing from a grant made elsewhere', async () => {
    const ctx = await mount()
    const granted = agentWithCwd('session-allow-5', '/work')
    const other = agentWithCwd('session-allow-6', '/work')

    const asked: unknown[] = []
    const ctxListener = vi.fn(async (req: unknown) => { asked.push(req); return 'allowed-once' })
    ctx.on('approval/request', ctxListener)
    ctx.permissionRules.addSessionAllow(granted, 'edit')
    const result = await ctx.tools.execute(exec('edit', { file_path: '/outside/x.txt' }, other))
    expect(result.isError).toBe(false)
    expect(asked).toHaveLength(1)
  })
})

describe('WS3 sandbox escalation auto-approval integration', () => {
  it('auto-approves a sandbox escalation in auto mode within the workspace', async () => {
    const ctx = await mount()
    const agent = agentWithCwd('sbx-auto-1', '/work')
    ctx.permissionRules.setMode(agent, 'auto')

    const reachedFallback = vi.fn(async () => 'allowed-once' as const)
    ctx.on('approval/request', reachedFallback)

    // A pre-execute listener AFTER the plugin injects a sandbox-escalation ask
    // (the plugin's own decide() passes unmatched LOW calls through).
    ctx.on('tools/pre-execute', async () => ({
      kind: 'ask',
      reason: 'sandbox escalation: write outside the per-call policy',
    }))

    const result = await ctx.tools.execute(exec('Bash', { command: 'ls' }, agent))
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('ran:ls')
    expect(reachedFallback).not.toHaveBeenCalled()

    const audit = agent.session.snapshotEvents().map(event => event as unknown as {
      type: string
      data: Record<string, unknown>
    }).filter(event => event.type === SESSION_ALLOW_EVENT)
    expect(audit).toHaveLength(1)
    expect(audit[0]!.data.scope).toBe('sandbox-auto')
  })

  it('asks (falls through to the UI provider) in default mode', async () => {
    const ctx = await mount()
    const agent = agentWithCwd('sbx-auto-2', '/work')
    const reachedFallback = vi.fn(async () => 'allowed-once' as const)
    ctx.on('approval/request', reachedFallback)
    ctx.on('tools/pre-execute', async () => ({
      kind: 'ask',
      reason: 'sandbox escalation: write outside the per-call policy',
    }))

    const result = await ctx.tools.execute(exec('Bash', { command: 'ls' }, agent))
    expect(result.isError).toBe(false)
    expect(reachedFallback).toHaveBeenCalledOnce()
  })

  it('falls through when the session has no workspace root', async () => {
    const ctx = await mount()
    const session = Session.create(SessionId('sbx-auto-3'))
    session.append('turn/start', { turn: 1 })
    const agent = { id: 'sbx-auto-3', session, inject: () => {} } as unknown as Agent
    ctx.permissionRules.setMode(agent, 'auto')
    const reachedFallback = vi.fn(async () => 'allowed-once' as const)
    ctx.on('approval/request', reachedFallback)
    ctx.on('tools/pre-execute', async () => ({
      kind: 'ask',
      reason: 'sandbox escalation: write outside the per-call policy',
    }))

    await ctx.tools.execute(exec('Bash', { command: 'ls' }, agent))
    expect(reachedFallback).toHaveBeenCalledOnce()
  })
})
