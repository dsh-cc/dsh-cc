import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type ToolExecutionInput, type ToolExecutionResult } from '@dsh-cc/tools'
import ApprovalService, { type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { SettingsProvider } from '@dsh-cc/settings-provider'
import PermissionRules, { type Config } from '@dsh-cc/permission-rules'
import type { Agent } from '@deepseek-ai/dsh-agent'

/**
 * R1 (design §7) end-to-end ask-semantics probe for the 0.1.7-rc.2 permission
 * waterfall. A MEDIUM-risk call in `default` mode maps to `ask`; the ask
 * routes through the approval seam and proceeds ONLY when it returns
 * `allowed-once`; with NO approval service mounted the ask must fail closed
 * (deny) — it must never silently auto-allow. `cancel` and `ask.displayReason`
 * are new INPUTS to this same path, which is why the probe rides the migration
 * even though the ask routing itself dates to 0.1.5.
 */

const testToolSignal = new AbortController().signal

class MemorySettings extends SettingsProvider {
  readonly doc: Record<string, unknown> = {}
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(this.doc)) }
  protected persist(ns: string, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
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

function agentOf(id: string): Agent {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  return { id, session, inject: () => {} } as unknown as Agent
}

/** Mount the default-mode waterfall, drive one unsandboxed Bash call, report the outcome. */
async function probe(
  withApproval: boolean,
  answerer: (req: ApprovalRequest) => Promise<'allowed-once' | 'rejected'>,
): Promise<{ asked: ApprovalRequest[]; result: ToolExecutionResult; ran: boolean }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (withApproval) await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(MemorySettings)
  await ctx.plugin(PermissionRules, {
    bashToolName: 'Bash',
    fileEditTools: ['edit'],
    readOnlyTools: ['read'],
  } satisfies Config)
  let ran = false
  ctx.tools.register(defineContentToolFixture({
    name: 'Bash',
    description: 'shell',
    parameters: { command: { type: 'string' } },
    async execute(args) { ran = true; return [{ type: 'text', text: `ran:${(args as { command: string }).command}` }] },
  }))
  const asked: ApprovalRequest[] = []
  if (withApproval) ctx.on('approval/request', async (req) => { asked.push(req); return answerer(req) })
  const agent = agentOf('probe')
  ctx.permissionRules.setMode(agent, 'default')
  const result = await ctx.tools.execute(exec('Bash', { command: 'git push --force origin main' }, agent))
  return { asked, result, ran }
}

describe('R1 ask-semantics waterfall probe (permission-rules × approval seam)', () => {
  it('an ask decision reaches the approval seam and runs only on allowed-once', async () => {
    const { asked, result, ran } = await probe(true, () => Promise.resolve('allowed-once' as const))
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ toolName: 'Bash' })
    expect(ran).toBe(true)
    expect(result.isError).toBe(false)
  })

  it('a rejected outcome denies the ask (tool never runs)', async () => {
    const { asked, result, ran } = await probe(true, () => Promise.resolve('rejected' as const))
    expect(asked).toHaveLength(1)
    expect(ran).toBe(false)
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('rejected')
  })

  it('NO approval service mounted → ask does NOT silently auto-allow (fails closed)', async () => {
    const { result, ran } = await probe(false, () => { throw new Error('approval seam must not be reached') })
    expect(ran).toBe(false)
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('approval')
  })
})
