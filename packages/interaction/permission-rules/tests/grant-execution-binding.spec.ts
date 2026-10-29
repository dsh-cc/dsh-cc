import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { currentToolExecution, type ToolDefinition, type ToolExecution } from '@dsh-cc/tools'
import { createSandboxApprovalListener } from '../src/approval-listener.ts'
import { GrantEscalations } from '../src/grant-escalation.ts'
import { TaskGrantStore, appendTaskGrantEvent, buildTaskGrant, validateDescriptor } from '../src/task-grant.ts'

const reason = 'escalate sandbox to workspace-write: needs workspace'
async function fixture() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const session = Session.create(SessionId(`binding-${Math.random()}`))
  const agent = { id: 'agent', session } as unknown as Agent
  const grant = buildTaskGrant({ root: '/work', branch: 'task', goalId: null, face: validateDescriptor({ rules: ['Bash(git add)'], tools: [], writePaths: ['docs/'], sandboxEscalation: true, contentScope: 'any' }) })
  appendTaskGrantEvent(session, { grant, timestamp: Date.now() })
  const store = new TaskGrantStore()
  store.add(String(session.id), () => session.snapshotEvents(), grant)
  let duringCheck: () => void = () => {}
  const grants = new GrantEscalations({ store, git: async () => { duringCheck(); return 'task\n' } })
  const listener = createSandboxApprovalListener({ grants, modeOf: () => 'auto', workspaceOf: () => '/work' })
  const request = (overrides = {}) => listener({ agent, toolName: 'Bash', callId: ToolCallId('same'), reason, ...overrides }, async () => 'rejected')
  const register = (exec: ToolExecution) => grants.register({ session, agentId: String(agent.id), toolName: exec.name, callId: String(exec.callId), command: (exec.arguments as { command: string }).command, grant, executionToken: exec.token })
  const run = async (body: ToolDefinition['execute'], registerCall = true) => {
    const stop = registerCall ? ctx.on('tools/pre-execute', (exec, next) => { register(exec); return next() }) : () => {}
    const unregister = ctx.tools.register({ name: 'Bash', description: 'test', parameters: { type: 'object' }, output: { schema: { type: 'null' }, render: () => [] }, execute: body })
    const result = await ctx.tools.execute({ name: 'Bash', callId: ToolCallId('same'), arguments: { command: 'git add docs/a.md' }, agent, signal: new AbortController().signal })
    unregister()
    stop()
    expect(result.isError).toBe(false)
  }
  return { ctx, session, agent, grant, store, grants, request, register, run, onCheck: (fn: () => void) => { duringCheck = fn } }
}

describe('grant approval runtime execution binding', () => {
  it('requires the actual body context and consumes an entry once', async () => {
    const f = await fixture()
    await f.run(async () => {
      expect(currentToolExecution()).toBeDefined()
      expect(await f.request()).toBe('allowed-once')
      expect(await f.request()).toBe('rejected')
      return null
    })
  })

  it('does not replay a settled call registration when another execution reuses its call ID', async () => {
    const f = await fixture()
    await f.run(async () => null)
    await f.run(async () => { expect(await f.request()).toBe('rejected'); return null }, false)
  })

  it('rejects approval outside the body even with a registered matching call ID', async () => {
    const f = await fixture()
    await f.run(async () => null)
    expect(await f.request()).toBe('rejected')
  })

  it.each(['agent', 'tool', 'call'])('rejects a mismatched %s in the approval descriptor', async field => {
    const f = await fixture()
    await f.run(async () => {
      const overrides = field === 'agent' ? { agent: { ...f.agent, id: 'other' } } : field === 'tool' ? { toolName: 'Other' } : { callId: ToolCallId('other') }
      expect(await f.request(overrides)).toBe('rejected')
      return null
    })
  })

  it('rechecks revocation after an awaited guard and never falls back to baseline auto mode', async () => {
    const f = await fixture()
    f.onCheck(() => f.store.remove(String(f.session.id), () => f.session.snapshotEvents(), f.grant.grantId))
    await f.run(async () => { expect(await f.request()).toBe('rejected'); return null })
  })

  it('clears a registration when its execution settles', async () => {
    const f = await fixture()
    f.ctx.on('tools/result', exec => f.grants.clearExecution(exec.token))
    await f.run(async () => null)
    await f.run(async () => { expect(await f.request()).toBe('rejected'); return null }, false)
  })
})
