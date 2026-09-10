/**
 * Tests for the one-shot visibility wiring (W2a/c): `mountOneShotVisibility`
 * attaches the shared subagent/start+end ledger and the parent-scoped
 * pre-step notice to a real cordis context, so apply() surfaces active
 * long-running children to exactly their parent sessions. Delivery is the
 * enter-decision batch rewrite (NOT agent.inject — see one-shot-notice.ts).
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { mountOneShotVisibility } from '../src/index.ts'

const enter: PreStepDecision = { kind: 'enter', messages: [] }

/** Texts the notice appended to the returned enter decision. */
function appendedTexts(decision: PreStepDecision): string[] {
  if (decision.kind !== 'enter') return []
  return decision.messages.flatMap(message =>
    message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
}

function fakeAgent(sessionId: string): Agent {
  return { session: { id: sessionId } } as unknown as Agent
}

describe('one-shot visibility wiring', () => {
  it('mounts the pre-step notice: matching parent gets one line, bystander nothing', async () => {
    const ctx = new Context()
    ctx.provide('agents', {
      get(id: string) {
        return id === 'c1'
          ? { session: { header: { parentSession: 'p1' }, events: [{ type: 'subagent/descriptor', data: { mode: 'continuable', label: 'worker' } }] } }
          : undefined
      },
    })
    mountOneShotVisibility(ctx)
    ctx.emit('subagent/start' as never, { runId: 'r1', id: 'c1', provider: 'spawn' } as never)
    const matchingAgent = fakeAgent('p1')
    const bystanderAgent = fakeAgent('p2')
    const bystander = await ctx.waterfall(
      ctx as never,
      'agent/pre-step',
      { agent: bystanderAgent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve(enter),
    )
    const matching = await ctx.waterfall(
      ctx as never,
      'agent/pre-step',
      { agent: matchingAgent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve(enter),
    )
    expect(appendedTexts(matching)).toHaveLength(1)
    expect(appendedTexts(matching)[0]).toContain('worker')
    expect(appendedTexts(bystander)).toEqual([])
    await ctx.fiber.dispose()
  })

  it('zero active children: the decision is returned unmodified', async () => {
    const ctx = new Context()
    mountOneShotVisibility(ctx)
    const { agent } = { agent: fakeAgent('p1') }
    const decision = { kind: 'enter', messages: [] } as const
    const returned = await ctx.waterfall(
      ctx as never,
      'agent/pre-step',
      { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve(decision),
    )
    expect(returned).toBe(decision)
    await ctx.fiber.dispose()
  })
})
