/**
 * Scripted session tests (plan DoD 2 busy-vein pin + DoD 3) against the REAL
 * harness agent loop, via `@deepseek-ai/dsh-agent-loop-testkit` (real
 * AgentLoop, claim-based pending admission, real durable inbox).
 *
 * - Busy vein: a run settling while the session is busy delivers through the
 *   `agent/pre-step` enter-decision batch and NEVER enters the pending inbox.
 * - Idle wake (DoD 3): a run that outlives its launching turn completes while
 *   the session is idle → exactly ONE wake delivers the consolidated payload
 *   (turn count + inbox contents), and no residual pending message re-opens
 *   further turns.
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
import { WorkflowEngine, WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type {
  WorkflowResult, WorkflowRun,
  WorkflowRunId as WorkflowRunIdType, WorkflowStartRequest,
} from '@deepseek-ai/dsh-workflow'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'
import { startWorkflowRun } from '../src/launch.ts'
import { mountCcWorkflowRunRegistry } from '../src/registry.ts'
import type { CcWorkflowRunRegistry } from '../src/registry.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Scratch under the repo — never /tmp. */
function workspace(): string {
  const scratch = join(process.cwd(), '.scratch')
  mkdirSync(scratch, { recursive: true })
  const root = mkdtempSync(join(scratch, 'workflow-idle-wake-'))
  mkdirSync(join(root, 'workspace'), { recursive: true })
  roots.push(root)
  return root
}

class StubEngine extends WorkflowEngine {
  requests: WorkflowStartRequest[] = []
  private readonly settlements = new Map<WorkflowRunIdType, (result: WorkflowResult) => void>()

  start(request: WorkflowStartRequest): WorkflowRun {
    this.requests.push(request)
    const id = WorkflowRunId(`run-${this.requests.length}`)
    const result = new Promise<WorkflowResult>((resolve) => { this.settlements.set(id, resolve) })
    return {
      id,
      meta: request.meta,
      result,
      cancel: () => this.settlements.get(id)?.({ value: null, stopReason: 'cancelled', agentsStarted: 0 }),
      dispose: async () => {},
    }
  }

  settleRun(id: WorkflowRunIdType, result: WorkflowResult): void {
    const settle = this.settlements.get(id)
    if (settle === undefined) throw new Error(`unknown stub workflow ${id}`)
    settle(result)
  }
}

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  const root = workspace()
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(StubEngine)
  const disposeRegistry = mountCcWorkflowRunRegistry(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(
    SessionId('parent'),
    { provider: 'mock', model: 'mock' },
    { cwd: join(root, 'workspace') },
  )
  return { ctx, agent, adapter, disposeRegistry }
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

function depsOf(ctx: Context) {
  return {
    engine: ctx.workflowEngine as StubEngine,
    registry: ctx.ccWorkflowRunRegistry as CcWorkflowRunRegistry,
    maxResultChars: 50_000,
  }
}

const META_BLOCK = `export const meta = { name: 'long-run', description: 'outlives a turn' }`

describe('workflow completion delivery (real AgentLoop via testkit)', () => {
  it('busy vein: a run settling while the session is busy lands in the pre-step batch, never the pending inbox', async () => {
    const { ctx, agent, adapter } = await setup([textResponse('first answer'), textResponse('second answer')])
    const batches: string[][] = []
    const deps = depsOf(ctx)
    let launched = false
    // Registry pre-step listener mounts before this one → it post-processes
    // (outer waterfall), so a settle performed here is visible to it.
    agent.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind === 'enter') batches.push(batchTexts(decision.messages))
      return decision
    })
    agent.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind === 'enter' && !launched) {
        launched = true
        const receipt = startWorkflowRun(deps, { script: `${META_BLOCK}\nreturn { done: true }` }, { agent })
        expect(receipt.status).toBe('async_launched')
      }
      return decision
    })

    agent.followup(userText('turn one'))
    await agent.whenIdle()
    expect(launched).toBe(true)

    // Turn two: settle the run while the session is busy (inside the pre-step
    // waterfall, before the registry listener post-processes the decision).
    let settled = false
    agent.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind === 'enter' && !settled) {
        settled = true
        deps.engine.settleRun(WorkflowRunId('run-1'), { value: { done: true }, stopReason: 'completed', agentsStarted: 1 })
      }
      return decision
    })
    agent.followup(userText('turn two'))
    await agent.whenIdle()

    // Delivered through the enter-decision batch of turn two: the turn-two
    // model request carries the completion message.
    type ReqMessage = { source?: { kind?: string }; content?: { text?: string }[] }
    const turnTwoRequest = adapter.requests[adapter.requests.length - 1] as { messages: ReqMessage[] }
    const completion = turnTwoRequest.messages.find(message => message.source?.kind === 'cc-workflow-completion')
    expect(completion?.content?.map(block => block.text ?? '').join('')).toContain('"done": true')
    // Never entered the pending inbox: no residual pending message.
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(agent.inbox.nextStep).toHaveLength(0)
  }, 20_000)

  it('idle wake (DoD 3): a run outliving its turn completes while idle → exactly one wake, no residual pending', async () => {
    const { ctx, agent, adapter } = await setup([textResponse('first answer'), textResponse('second answer')])
    const deps = depsOf(ctx)
    const batches: string[][] = []
    let launched = false
    agent.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind === 'enter' && !launched) {
        launched = true
        const receipt = startWorkflowRun(deps, { script: `${META_BLOCK}\nreturn { done: true }` }, { agent })
        expect(receipt.status).toBe('async_launched')
        expect(receipt.runId).toBe('run-1')
      }
      if (decision.kind === 'enter') batches.push(batchTexts(decision.messages))
      return decision
    })

    agent.followup(userText('turn one'))
    await agent.whenIdle()
    expect(launched).toBe(true)
    // The run is still in flight; the session is idle.
    expect(agent.status).toBe('idle')

    // The run completes while the session is idle → exactly one wake.
    deps.engine.settleRun(WorkflowRunId('run-1'), { value: { done: true }, stopReason: 'completed', agentsStarted: 2 })
    await agent.whenIdle()

    // Exactly one wake: exactly one additional model turn delivered the payload.
    expect(adapter.requests.length).toBe(2)
    const wakeBatch = batches[batches.length - 1]!.join('\n')
    expect(wakeBatch).toContain('"done": true')
    expect(wakeBatch).toContain('completed (2 agents)')
    // No residual pending message re-opens further turns.
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(agent.inbox.nextStep).toHaveLength(0)
    expect(agent.status).toBe('idle')
  }, 20_000)
})
