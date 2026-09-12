/**
 * Mechanism pin tests (Step 0) against the REAL harness testkit agent loop:
 * T1 pins that a pre-step decision batch append enriches only the current
 * step (appended messages are NOT re-claimed by a later pre-step), and T2
 * pins that `agent.inject()` during a turn re-opens a new turn — the wake
 * mechanism behind the phantom-loop bug the notice rewrite removes.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Scratch under the repo — never /tmp. */
function workspace(): string {
  const scratch = join(process.cwd(), '.scratch')
  mkdirSync(scratch, { recursive: true })
  const root = mkdtempSync(join(scratch, 'mechanism-pins-'))
  mkdirSync(join(root, 'workspace'), { recursive: true })
  roots.push(root)
  return root
}

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  const root = workspace()
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(
    SessionId('parent'),
    { provider: 'mock', model: 'mock' },
    { cwd: join(root, 'workspace') },
  )
  return { ctx, agent, adapter }
}

function userText(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** Texts of a claimed pre-step batch, in order. */
function batchTexts(messages: readonly UserMessage[]): string[] {
  return messages.flatMap(message =>
    message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
}

describe('pre-step mechanism pins', () => {
  it('T1: an enter-batch append enriches the current step and is not re-claimed by a later pre-step', async () => {
    const { agent, adapter } = await setup([textResponse('first'), textResponse('second')])
    const claimedBatches: string[][] = []
    const MARKER = 'PINNED-MARKER-CONTEXT'
    agent.ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      claimedBatches.push(batchTexts(decision.messages))
      if (claimedBatches.length === 1) {
        return {
          ...decision,
          messages: [...decision.messages, createUserMessage({
            content: [{ type: 'text', text: MARKER }],
            source: { kind: 'user' },
          })],
        }
      }
      return decision
    })

    agent.followup(userText('turn one'))
    await agent.whenIdle()
    // The appended marker must be part of the current step's context: the
    // first model request carries it, and the second turn's claimed batch
    // (a fresh user message re-presented) must NOT contain it.
    agent.followup(userText('turn two'))
    await agent.whenIdle()

    expect(claimedBatches.length).toBeGreaterThanOrEqual(2)
    expect(claimedBatches[0]).toContain('turn one')
    expect(claimedBatches[1]).toContain('turn two')
    expect(claimedBatches[1]).not.toContain(MARKER)
    // The marker was delivered into the first step's request context.
    const firstRequest = adapter.requests[0]
    const requestText = JSON.stringify(firstRequest)
    expect(requestText).toContain(MARKER)
  }, 20_000)

  it('T2: an agent.inject() during a turn re-opens a new turn after the turn would otherwise end', async () => {
    const { agent } = await setup([textResponse('first answer'), textResponse('second answer')])
    let turnCount = 0
    let injected = false
    agent.ctx.on('agent/pre-step', async (payload, next) => {
      turnCount += 1
      const decision = await next()
      if (turnCount === 1 && !injected) {
        injected = true
        agent.inject(createUserMessage({
          content: [{ type: 'text', text: 'injected pending context' }],
          source: { kind: 'user' },
        }))
      }
      return decision
    })

    agent.followup(userText('turn one'))
    await agent.whenIdle()
    // The injected pending message sat in the inbox; the loop must have
    // re-opened a second turn (the phantom-wake mechanism).
    expect(turnCount).toBeGreaterThanOrEqual(2)
    expect(injected).toBe(true)
  }, 20_000)
})
