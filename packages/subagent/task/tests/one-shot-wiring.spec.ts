/**
 * Tests for the one-shot visibility wiring (W2a/c): `mountOneShotVisibility`
 * attaches the shared subagent/start+end ledger and the parent-scoped
 * pre-step notice to a real cordis context, so apply() surfaces active
 * long-running children to exactly their parent sessions.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { mountOneShotVisibility } from '../src/index.ts'

const enter: PreStepDecision = { kind: 'enter', messages: [] }

function fakeAgent(sessionId: string): { agent: Agent; injected: unknown[] } {
  const injected: unknown[] = []
  return { agent: { session: { id: sessionId }, inject: (m: unknown) => injected.push(m) } as unknown as Agent, injected }
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
    const matching = fakeAgent('p1')
    const bystander = fakeAgent('p2')
    for (const { agent, injected } of [matching, bystander]) {
      await ctx.waterfall(
        ctx as never,
        'agent/pre-step',
        { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
        () => Promise.resolve(enter),
      )
      void agent
    }
    expect(matching.injected).toHaveLength(1)
    expect(bystander.injected).toEqual([])
    await ctx.fiber.dispose()
  })

  it('zero active children: no listener emissions at all', async () => {
    const ctx = new Context()
    mountOneShotVisibility(ctx)
    const { agent, injected } = fakeAgent('p1')
    await ctx.waterfall(
      ctx as never,
      'agent/pre-step',
      { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve(enter),
    )
    expect(injected).toEqual([])
    await ctx.fiber.dispose()
  })
})
