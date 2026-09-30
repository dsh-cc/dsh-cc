import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import ApprovalService, { type ApprovalOutcome, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { defineContentToolFixture, TOOL_ABORTED_BEFORE_DISPATCH, type PreToolDecision } from '@dsh-cc/tools'
import * as HooksClaude from '@dsh-cc/hooks-claude-code'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'

/**
 * Q1 layer 2: the hook×downstream PreToolDecision verdict fold, tested where
 * the fold lives (the bridge listener). Hooks can never emit `cancel` (the CC
 * codec is allow|deny|ask only) — downstream cancel must return BEFORE hook
 * ask/allow folding; downstream deny always wins; deny.info/ask.displayReason
 * pass through when their side wins.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function dir(): string { const d = mkdtempSync(join(tmpdir(), 'dsh-fold-')); dirs.push(d); return d }
function sh(d: string, name: string, body: string): string {
  const p = join(d, name); writeFileSync(p, body); chmodSync(p, 0o755); return p
}
function hooks(d: string, h: unknown): string {
  writeFileSync(join(d, 'hooks.json'), JSON.stringify({ hooks: h })); return join(d, 'hooks.json')
}

/** CC hook script emitting one PreToolUse permissionDecision (or a no-op). */
function hookScript(d: string, decision: 'allow' | 'deny' | 'ask' | 'none'): string {
  if (decision === 'none') return sh(d, 'noop.sh', '#!/usr/bin/env bash\nexit 0\n')
  const reason = decision === 'allow' ? '' : `,"permissionDecisionReason":"hook ${decision}"`
  return sh(d, 'h.sh', `#!/usr/bin/env bash\necho '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"${decision}"${reason}}}'\n`)
}

async function harness(configPath: string, adapter: MockAdapter, withApproval: boolean, beforeHooks?: (ctx: Context) => void): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  if (withApproval) await ctx.plugin(ApprovalService)
  beforeHooks?.(ctx)
  await ctx.plugin(HooksClaude, { configPath })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function events(agent: Agent): SessionEvent[] { return [...agent.session.snapshotEvents()] }

interface FoldOutcome {
  readonly ran: boolean
  readonly approvalAsked: boolean
  readonly isError: boolean
  readonly abortCode?: string
  readonly denyText?: string
}

/**
 * Drive one hook×downstream fold cell: PreToolUse hook emits `hook`, a
 * downstream boundary listener returns `downstream`; observe the executor
 * outcome for one echo tool call.
 */
async function runCell(hook: 'allow' | 'deny' | 'ask' | 'none', downstream: 'allow' | 'deny' | 'ask' | 'cancel'): Promise<FoldOutcome> {
  const d = dir()
  const configPath = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: hookScript(d, hook) }] }] })
  const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
  const requests: ApprovalRequest[] = []
  const ctx = await harness(configPath, adapter, true)
  let ran = false
  ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
  // The downstream boundary mounts as its own plugin composed AFTER the
  // bridge (sibling plugin fibers dispatch in compose order), mirroring how
  // permission-rules sits downstream of the prepended bridge listener.
  await ctx.plugin((c: Context) => {
    c.on('tools/pre-execute', async (_exec, next): Promise<PreToolDecision> => {
      await next()
      return downstream === 'allow' ? { kind: 'allow' }
        : downstream === 'deny' ? { kind: 'deny', reason: 'downstream deny', info: { name: 'BoundaryError', code: 'BOUNDARY' } }
        : downstream === 'ask' ? { kind: 'ask', reason: 'downstream asks', displayReason: { en: 'Allow?' } }
        : { kind: 'cancel' }
    })
  })
  ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
    requests.push(req)
    return next()
  })
  const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const result = events(agent).find(e => e.type === 'tool/result')
  if (result?.type !== 'tool/result') throw new Error('no tool result')
  const message = result.data.message as { isError?: boolean; content: { type: string; text?: string }[]; error?: { info?: { code?: string } } }
  return {
    ran,
    approvalAsked: requests.length > 0,
    isError: message.isError === true,
    abortCode: (result.data as { error?: { code?: string } }).error?.code,
    denyText: message.content.find(b => b.type === 'text')?.text,
  }
}

describe('hooks-claude-code PreToolUse verdict fold (hook × downstream)', () => {
  const hookDeny = async (downstream: 'allow' | 'deny' | 'ask' | 'cancel'): Promise<FoldOutcome> => await runCell('deny', downstream)
  const hookAsk = async (downstream: 'allow' | 'deny' | 'ask' | 'cancel'): Promise<FoldOutcome> => await runCell('ask', downstream)
  const hookAllow = async (downstream: 'allow' | 'deny' | 'ask' | 'cancel'): Promise<FoldOutcome> => await runCell('allow', downstream)
  const noHook = async (downstream: 'allow' | 'deny' | 'ask' | 'cancel'): Promise<FoldOutcome> => await runCell('none', downstream)

  it('downstream deny always wins, in every hook row, with deny.info pass-through', async () => {
    for (const [hook, cell] of [['none', noHook], ['allow', hookAllow], ['ask', hookAsk], ['deny', hookDeny]] as const) {
      const outcome = await cell('deny')
      expect(outcome.ran, `hook=${hook}`).toBe(false)
      expect(outcome.isError, `hook=${hook}`).toBe(true)
      // Pass-through: the deny reason and structured identity survive the fold.
      expect(outcome.denyText, `hook=${hook}`).toContain('downstream deny')
      expect(outcome.abortCode, `hook=${hook}`).toBe('BOUNDARY')
    }
  })

  it('downstream cancel outranks hook allow and hook ask, never masks deny', async () => {
    for (const [hook, cell] of [['none', noHook], ['allow', hookAllow], ['ask', hookAsk]] as const) {
      const outcome = await cell('cancel')
      expect(outcome.ran, `hook=${hook}`).toBe(false)
      expect(outcome.approvalAsked, `hook=${hook} must not ask after a cancel`).toBe(false)
      expect(outcome.abortCode, `hook=${hook}`).toBe(TOOL_ABORTED_BEFORE_DISPATCH)
    }
    // A hook deny still refuses the tool over a downstream cancel (deny
    // outranks cancel whenever the bridge verdict is consulted first).
    const denied = await hookDeny('cancel')
    expect(denied.isError).toBe(true)
    expect(denied.ran).toBe(false)
  })

  it('deny.info and ask.displayReason pass through when their side wins', async () => {
    const d = dir()
    const configPath = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: hookScript(d, 'ask') }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(configPath, adapter, true)
    const seen: ApprovalRequest[] = []
    ctx.on('approval/request', (req) => {
      seen.push(req)
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
    let ran = false
    ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
    ctx.on('tools/pre-execute', async (_exec, next): Promise<PreToolDecision> => {
      await next()
      return { kind: 'ask', reason: 'downstream asks', displayReason: { en: 'Allow it?' } }
    })
    const agent = await ctx.agentLoop.create(SessionId('a2'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(ran).toBe(true)
    expect(seen[0]).toMatchObject({ reason: 'downstream asks', displayReason: { en: 'Allow it?' } })
  })
})
