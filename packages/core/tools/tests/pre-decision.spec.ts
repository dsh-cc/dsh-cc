/**
 * PreToolDecision executor contract (harness 0.1.7 Q1 layer 1+3): the `cancel`
 * kind short-circuits dispatch into the canonical ABORTED_BEFORE_DISPATCH
 * result (never a policy denial, never a dispatch), `deny.info` rides into the
 * materialized result, and `ask.displayReason` reaches the approval seam.
 * @module @dsh-cc/tools/pre-decision.spec
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ApprovalService, { type ApprovalOutcome, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import ToolRuntime, { defineTool, TOOL_ABORTED_BEFORE_DISPATCH, type PreToolDecision } from '@dsh-cc/tools'

const testToolSignal = new AbortController().signal

async function setup() {
  const ctx = new Context()
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

/** Minimal Agent stand-in satisfying the approval seam's audit enclosure. */
function fakeAgent(): Agent {
  const events = [{ type: 'turn/start', data: { turn: 1 } }] as never[]
  return {
    session: {
      seq: events.length,
      snapshotEvents: (): readonly unknown[] => [...events],
      eventAt: (seq: number): unknown => events[seq],
      append: (type: string, data: unknown) => {
        events.push({ type, data })
        return {}
      },
    },
  } as unknown as Agent
}

describe('PreToolDecision executor contract', () => {
  it('cancel selects the canonical abort-before-dispatch result and NEVER dispatches', async () => {
    const ctx = await setup()
    let dispatched = 0
    ctx.tools.register({
      ...echoTool,
      name: 'probe',
      async execute() { dispatched += 1; return 'ran' },
    } as never)
    ctx.on('tools/pre-execute', async (_exec, _next): Promise<PreToolDecision> => ({ kind: 'cancel' }))

    await expect(ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c1'), name: 'probe', arguments: {} }))
      .resolves.toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
        error: { info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH } },
      })
    expect(dispatched).toBe(0)
  })

  it('deny.info rides into the materialized error result (structured identity, not stderr)', async () => {
    const ctx = await setup()
    ctx.tools.register(echoTool)
    ctx.on('tools/pre-execute', async (_exec, _next): Promise<PreToolDecision> =>
      ({ kind: 'deny', reason: 'denied by policy', info: { name: 'PolicyError', code: 'POLICY_DENIED' } }))

    await expect(ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c1'), name: 'echo', arguments: {} }))
      .resolves.toMatchObject({
        isError: true,
        content: [{ type: 'text', text: 'Error: denied by policy' }],
        error: { message: 'denied by policy', info: { name: 'PolicyError', code: 'POLICY_DENIED' } },
      })
  })

  it('ask.displayReason forwards into the approval request next to the audited reason', async () => {
    const ctx = await setup()
    await ctx.plugin(ApprovalService)
    ctx.tools.register(echoTool)
    const seen: ApprovalRequest[] = []
    ctx.on('approval/request', (req) => {
      seen.push(req)
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })
    ctx.on('tools/pre-execute', async (_exec, _next): Promise<PreToolDecision> =>
      ({ kind: 'ask', reason: 'hook wants a human', displayReason: { en: 'Allow it?', zh: '允许吗？' } }))

    const result = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c1'), name: 'echo', arguments: {}, agent: fakeAgent() })
    expect(result.isError).toBe(false)
    expect(seen[0]).toMatchObject({
      reason: 'hook wants a human',
      displayReason: { en: 'Allow it?', zh: '允许吗？' },
    })
  })
})
