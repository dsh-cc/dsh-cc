/**
 * Ask-rejection guidance for unattended delegated sessions (design
 * docs/plans/2026-11-17-executor-reliability-fixes.md §D1, cases 1–12):
 * export-level folds over synthetic inputs (1–4) plus the serviceAsk branch
 * matrix through a stub approval service and stub agents whose sessions
 * return synthetic `approval/policy` event arrays (5–12). The stub records
 * each `approval.request` call, proving policy-`never` rejections still flow
 * through the approval seam — only the deny COPY specializes.
 * @module @dsh-cc/tools/ask-guidance.spec
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ApprovalService, { type ApprovalOutcome, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import ToolRuntime, { defineTool, type PreToolDecision } from '@dsh-cc/tools'
import { executeToolInvocation } from './executor-fixture.ts'
import {
  approvalPolicyIsNever,
  ASK_CHANNEL_GUIDANCE,
  ASK_DENIAL_GUIDANCE,
  classifyAskReason,
  isDelegatedSession,
  sanitizeAskReason,
  SUBAGENT_ASK_PREFIX,
  subagentAskGuidance,
} from '../src/ask-guidance.ts'

const testToolSignal = new AbortController().signal

async function setup() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

const echoTool = defineTool({
  name: 'echo',
  description: 'echo arguments back',
  parameters: { text: { type: 'string' } },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args) {
    return args.text ?? ''
  },
})

/** Synthetic agent: a session stub over a caller-supplied event array. */
function stubAgent(events: readonly unknown[], delegated: boolean): Agent {
  return {
    session: {
      header: delegated ? { origin: 'subagent' } : {},
      snapshotEvents: () => [...events],
    },
    ...(delegated ? { options: { subagentDepth: 1 } } : {}),
  } as unknown as Agent
}

/** Stand-in approval service resolving one fixed outcome; records requests. */
function stubApproval(outcome: ApprovalOutcome) {
  const requests: ApprovalRequest[] = []
  const service = {
    request: (req: ApprovalRequest) => {
      requests.push(req)
      return Promise.resolve(outcome)
    },
  } as unknown as ApprovalService
  return { requests, service }
}

const NEVER_EVENT = { type: 'approval/policy', data: { policy: 'never', source: 'delegation' } }
const ASK_EVENT = { type: 'approval/policy', data: { policy: 'ask' } }
const UNDERSPEC_REASON = 'target/scope under-specified (underspec detector)'
const ASK_REASON = 'hook wants a human'

const UNDERSPECIFIED_SENTENCE =
  'The trigger is an under-specified target or scope: you may retry ONCE with a materially narrower, explicitly scoped command; if this message appears again, stop.'
const TRANSIENT_SENTENCE =
  'The trigger is a transient classifier failure: you may retry the identical command ONCE; if this message appears again, stop.'
const STRUCTURAL_SENTENCE =
  'Do not retry the call and do not work around the permission system; report this message and the exact command as a Blocker in your final report.'

/** Register echo + raise one `ask` with the given reason from pre-execute. */
function askViaPreExecute(ctx: Context, reason: string | undefined): void {
  ctx.tools.register(echoTool)
  ctx.on('tools/pre-execute', async (_exec, _next): Promise<PreToolDecision> =>
    reason === undefined ? { kind: 'ask' } : { kind: 'ask', reason })
}

function textOf(result: { content: readonly unknown[] }): string {
  const block = (result.content as { type: string, text?: string }[])[0]
  return block.type === 'text' ? block.text ?? '' : ''
}

describe('ask-guidance (delegated ask rejections, design D1)', () => {
  it('1. approvalPolicyIsNever folds approval/policy events last-wins and skips malformed ones', () => {
    expect(approvalPolicyIsNever([NEVER_EVENT, ASK_EVENT])).toBe(false)
    expect(approvalPolicyIsNever([ASK_EVENT, NEVER_EVENT])).toBe(true)
    expect(approvalPolicyIsNever([])).toBe(false)
    // Malformed wire entries are skipped, never thrown on.
    expect(approvalPolicyIsNever([NEVER_EVENT, null, 42, 'approval/policy', { type: 'turn/start', data: {} }, undefined])).toBe(true)
    expect(approvalPolicyIsNever([null, 42])).toBe(false)
    // An `approval/policy` event without a parseable policy decides false.
    expect(approvalPolicyIsNever([NEVER_EVENT, { type: 'approval/policy' }])).toBe(false)
  })

  it('2. isDelegatedSession reads origin, header depth, and runtime depth, failing closed', () => {
    expect(isDelegatedSession({ session: { header: { origin: 'subagent' } } })).toBe(true)
    expect(isDelegatedSession({ session: { header: { delegationDepth: 1 } } })).toBe(true)
    expect(isDelegatedSession({ session: { header: {} }, options: { subagentDepth: 2 } })).toBe(true)
    expect(isDelegatedSession({ session: { header: {} } })).toBe(false)
    expect(isDelegatedSession(undefined)).toBe(false)
    // A malformed agent SHAPE that has a session counts as a child.
    const malformed = { session: { get header(): never { throw new Error('unreadable') } } }
    expect(isDelegatedSession(malformed)).toBe(true)
    // An unsafe/negative runtime depth is a child.
    expect(isDelegatedSession({ session: { header: {} }, options: { subagentDepth: -1 } })).toBe(true)
  })

  it('3. classifyAskReason buckets the closed prefix table, structural fail-closed', () => {
    expect(classifyAskReason(UNDERSPEC_REASON)).toBe('underspecified')
    expect(classifyAskReason('state truncated by gateway (4032 chars)')).toBe('transient')
    expect(classifyAskReason('gauge output unusable: empty response')).toBe('transient')
    expect(classifyAskReason('gauge allow probability missing or invalid')).toBe('transient')
    expect(classifyAskReason('unrecognized gauge choice "maybe"')).toBe('transient')
    expect(classifyAskReason('gauge allow below threshold (P(allow)=0.430, t=0.5)')).toBe('structural')
    expect(classifyAskReason('deny downgraded to ask (permission mode acceptEdits)')).toBe('structural')
    expect(classifyAskReason('an unknown reason from a third-party hook')).toBe('structural')
    expect(classifyAskReason(undefined)).toBe('structural')
  })

  it('4. subagentAskGuidance embeds the prefix, the sanitized trigger, and the category sentence', () => {
    expect(subagentAskGuidance('bash', UNDERSPEC_REASON))
      .toBe(`${SUBAGENT_ASK_PREFIX} (the ask was raised because: ${UNDERSPEC_REASON}). ${UNDERSPECIFIED_SENTENCE}`)
    expect(subagentAskGuidance('bash', 'gauge output unusable: empty response'))
      .toBe(`${SUBAGENT_ASK_PREFIX} (the ask was raised because: gauge output unusable: empty response). ${TRANSIENT_SENTENCE}`)
    expect(subagentAskGuidance('bash', 'gauge allow below threshold (P(allow)=0.430, t=0.5)'))
      .toBe(`${SUBAGENT_ASK_PREFIX} (the ask was raised because: gauge allow below threshold (P(allow)=0.430, t=0.5)). ${STRUCTURAL_SENTENCE}`)
    // Multiline + CJK + control characters collapse into one clause.
    expect(subagentAskGuidance('bash', 'line one\n第二行\tend'))
      .toBe(`${SUBAGENT_ASK_PREFIX} (the ask was raised because: line one 第二行 end). ${STRUCTURAL_SENTENCE}`)
    // An oversized trigger is capped exactly like sanitizeAskReason.
    expect(subagentAskGuidance('bash', 'x'.repeat(200)))
      .toBe(`${SUBAGENT_ASK_PREFIX} (the ask was raised because: ${sanitizeAskReason('x'.repeat(200))}). ${STRUCTURAL_SENTENCE}`)
    // No reason names the tool instead of quoting a trigger.
    expect(subagentAskGuidance('bash', undefined))
      .toBe(`${SUBAGENT_ASK_PREFIX} (tool "bash" was asked without a recorded reason). ${STRUCTURAL_SENTENCE}`)
  })

  it('5. delegated session + folded policy never + rejected → structured deny; the approval request still flows', async () => {
    const ctx = await setup()
    let dispatched = 0
    ctx.tools.register({
      ...echoTool,
      name: 'probe',
      async execute() { dispatched += 1; return 'dispatched' },
    } as never)
    const { requests, service } = stubApproval('rejected')
    ctx.provide('approval', service)
    ctx.on('tools/pre-execute', async (_exec, _next): Promise<PreToolDecision> => ({ kind: 'ask', reason: UNDERSPEC_REASON }))

    const result = await executeToolInvocation(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('c1'),
      name: 'probe',
      arguments: {},
      agent: stubAgent([NEVER_EVENT], true),
    })
    expect(result.isError).toBe(true)
    expect(dispatched).toBe(0)
    // The ask still flows through the approval seam — only the copy changed.
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ toolName: 'probe', reason: UNDERSPEC_REASON })
    expect(textOf(result))
      .toBe(`Error: ${SUBAGENT_ASK_PREFIX} (the ask was raised because: ${UNDERSPEC_REASON}). ${UNDERSPECIFIED_SENTENCE}`)
  })

  it('6. delegated session + folded policy ask + rejected → today\'s user-rejection copy byte-identical', async () => {
    const ctx = await setup()
    askViaPreExecute(ctx, ASK_REASON)
    const { service } = stubApproval('rejected')
    ctx.provide('approval', service)

    const result = await executeToolInvocation(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('c1'),
      name: 'echo',
      arguments: {},
      agent: stubAgent([ASK_EVENT], true),
    })
    expect(result.isError).toBe(true)
    expect(textOf(result))
      .toBe(`Error: the user rejected tool "echo" (the ask was raised because: ${ASK_REASON}). ${ASK_DENIAL_GUIDANCE}`)
  })

  it('7. main session + folded policy never + rejected → today\'s copy (ancestry gate holds)', async () => {
    const ctx = await setup()
    askViaPreExecute(ctx, ASK_REASON)
    const { service } = stubApproval('rejected')
    ctx.provide('approval', service)

    const result = await executeToolInvocation(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('c1'),
      name: 'echo',
      arguments: {},
      agent: stubAgent([NEVER_EVENT], false),
    })
    expect(result.isError).toBe(true)
    expect(textOf(result))
      .toBe(`Error: the user rejected tool "echo" (the ask was raised because: ${ASK_REASON}). ${ASK_DENIAL_GUIDANCE}`)
  })

  it('8. no approval service: delegated → structured deny; main → channel guidance unchanged', async () => {
    const delegatedCtx = await setup()
    askViaPreExecute(delegatedCtx, UNDERSPEC_REASON)
    const delegated = await executeToolInvocation(delegatedCtx, {
      signal: testToolSignal,
      callId: ToolCallId('c1'),
      name: 'echo',
      arguments: {},
      agent: stubAgent([NEVER_EVENT], true),
    })
    expect(delegated.isError).toBe(true)
    expect(textOf(delegated))
      .toBe(`Error: ${SUBAGENT_ASK_PREFIX} (the ask was raised because: ${UNDERSPEC_REASON}). ${UNDERSPECIFIED_SENTENCE}`)

    const mainCtx = await setup()
    askViaPreExecute(mainCtx, ASK_REASON)
    const main = await executeToolInvocation(mainCtx, {
      signal: testToolSignal,
      callId: ToolCallId('c1'),
      name: 'echo',
      arguments: {},
      agent: stubAgent([], false),
    })
    expect(main.isError).toBe(true)
    expect(textOf(main)).toBe(`Error: ${ASK_REASON}. ${ASK_CHANNEL_GUIDANCE}`)
  })

  it('9. unavailable: delegated + policy never → structured deny; main → channel copy unchanged', async () => {
    const delegatedCtx = await setup()
    askViaPreExecute(delegatedCtx, UNDERSPEC_REASON)
    const { service: delegatedService } = stubApproval('unavailable')
    delegatedCtx.provide('approval', delegatedService)
    const delegated = await executeToolInvocation(delegatedCtx, {
      signal: testToolSignal,
      callId: ToolCallId('c1'),
      name: 'echo',
      arguments: {},
      agent: stubAgent([NEVER_EVENT], true),
    })
    expect(delegated.isError).toBe(true)
    expect(textOf(delegated))
      .toBe(`Error: ${SUBAGENT_ASK_PREFIX} (the ask was raised because: ${UNDERSPEC_REASON}). ${UNDERSPECIFIED_SENTENCE}`)

    const mainCtx = await setup()
    askViaPreExecute(mainCtx, ASK_REASON)
    const { service: mainService } = stubApproval('unavailable')
    mainCtx.provide('approval', mainService)
    const main = await executeToolInvocation(mainCtx, {
      signal: testToolSignal,
      callId: ToolCallId('c1'),
      name: 'echo',
      arguments: {},
      agent: stubAgent([], false),
    })
    expect(main.isError).toBe(true)
    expect(textOf(main))
      .toBe(`Error: tool "echo" requires approval, but no approval channel is available (the ask was raised because: ${ASK_REASON}). ${ASK_CHANNEL_GUIDANCE}`)
  })

  it('10. allowed-once and cancelled branches are unchanged under delegation', async () => {
    const allowCtx = await setup()
    askViaPreExecute(allowCtx, UNDERSPEC_REASON)
    const { service: allowService } = stubApproval('allowed-once')
    allowCtx.provide('approval', allowService)
    const allowed = await executeToolInvocation(allowCtx, {
      signal: testToolSignal,
      callId: ToolCallId('c1'),
      name: 'echo',
      arguments: { text: 'ran' },
      agent: stubAgent([NEVER_EVENT], true),
    })
    expect(allowed.isError).toBe(false)
    expect(textOf(allowed)).toBe('ran')

    const cancelCtx = await setup()
    askViaPreExecute(cancelCtx, UNDERSPEC_REASON)
    const { service: cancelService } = stubApproval('cancelled')
    cancelCtx.provide('approval', cancelService)
    const cancelled = await executeToolInvocation(cancelCtx, {
      signal: testToolSignal,
      callId: ToolCallId('c1'),
      name: 'echo',
      arguments: {},
      agent: stubAgent([NEVER_EVENT], true),
    })
    expect(cancelled.isError).toBe(true)
    expect(textOf(cancelled)).toBe('Error: approval for tool "echo" was cancelled')
  })

  it('11. an oversized multiline reason is control-stripped and capped inside the structured deny', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    const reason = String(new Error(`first\nsecond\tline ${'x'.repeat(200)}`))
    ctx.on('tools/pre-execute', async (_exec, _next): Promise<PreToolDecision> => ({ kind: 'ask', reason }))
    const { service } = stubApproval('rejected')
    ctx.provide('approval', service)

    const result = await executeToolInvocation(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('c1'),
      name: 'echo',
      arguments: {},
      agent: stubAgent([NEVER_EVENT], true),
    })
    const text = textOf(result)
    expect(text.startsWith(`Error: ${SUBAGENT_ASK_PREFIX} (the ask was raised because: `)).toBe(true)
    expect(text.endsWith(`). ${STRUCTURAL_SENTENCE}`)).toBe(true)
    expect(text).not.toMatch(/[\n\t]/u)
    const clause = text.slice(
      'Error: '.length + SUBAGENT_ASK_PREFIX.length + ' (the ask was raised because: '.length,
      text.length - `). ${STRUCTURAL_SENTENCE}`.length,
    )
    expect(clause.length).toBe(120)
    expect(clause.endsWith('…')).toBe(true)
  })

  it('12. a mid-session switch to policy ask restores attended semantics on the very next call', async () => {
    const ctx = await setup()
    askViaPreExecute(ctx, ASK_REASON)
    const { service } = stubApproval('rejected')
    ctx.provide('approval', service)

    const result = await executeToolInvocation(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('c1'),
      name: 'echo',
      arguments: {},
      agent: stubAgent([NEVER_EVENT, ASK_EVENT], true),
    })
    expect(result.isError).toBe(true)
    expect(textOf(result))
      .toBe(`Error: the user rejected tool "echo" (the ask was raised because: ${ASK_REASON}). ${ASK_DENIAL_GUIDANCE}`)
  })
})
