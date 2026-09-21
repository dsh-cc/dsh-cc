/**
 * REAL composition specs (context-crusher composition pattern): the REAL
 * compaction-cost-gate plugin runs against the REAL agent loop with a
 * scripted mock MODEL — only the model and the compaction backend are
 * stubbed. Pins the two-seam flow end to end, the observe-only
 * PostToolDecision pass-through (the §8 residual-risk item), cooldown,
 * dry-run, and the hint-cleared-on-failure path.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  CompactionEngine,
  CompactionId,
  ManualCompactionError,
  type CompactionAgentContext,
  type CompactionResult,
  type CompactionTrigger,
  type ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { defineContentToolFixture } from '@dsh-cc/tools'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { takeCompactHint } from '@dsh-cc/compaction-basic'
import CompactionCostGate from '../src/index.ts'
import { CostGateLedger, projectKeyOf } from '../src/ledger.ts'

/** Stub engine recording calls, signals, hint-at-entry, and the failure mode. */
class StubCompactionEngine extends CompactionEngine {
  calls: { agent: ManualCompactAgentContext; signal: AbortSignal; source?: string }[] = []
  hintsAtCall: (string | undefined)[] = []
  failure: unknown

  override compactIfNeeded(): Promise<null> {
    return Promise.resolve(null)
  }

  override compactRegion(): Promise<never> {
    return Promise.reject(new Error('not used'))
  }

  override compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
    sourceCommandId?: string,
  ): Promise<null> {
    this.calls.push({ agent, signal, source: sourceCommandId })
    this.hintsAtCall.push(takeCompactHint(agent))
    if (this.failure !== undefined) return Promise.reject(this.failure)
    return Promise.resolve(null)
  }
}

interface Built {
  ctx: Context
  agent: Agent
  compact: StubCompactionEngine
  home: string
}

/**
 * Full real-loop harness: only the model (MockAdapter) and the compaction
 * backend (StubCompactionEngine) are stubbed; the gate plugin, tool runtime,
 * token meter, and agent loop are real. The settings reader is injected
 * through the plugin config seam (production reads the settings namespace).
 */
async function build(
  home: string,
  adapter: MockAdapter,
  opts: { mode?: 'dry-run' | 'on'; afterPlugin?: (ctx: Context) => void } = {},
): Promise<Built> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  void new TokenMeter(ctx)
  const compact = new StubCompactionEngine(ctx)
  const ledger = new CostGateLedger(join(home, 'compaction-cost-gate'))
  await ctx.plugin(CompactionCostGate, {
    readSettings: () => ({
      enabled: true,
      mode: opts.mode ?? 'on',
      margin: 0.5,
      cooldownMs: 600_000,
    }),
    ledger,
  })
  opts.afterPlugin?.(ctx)
  ctx.tools.register(defineContentToolFixture({
    name: 'todo_write',
    description: 'write the plan todos',
    parameters: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- arguments are pass-through to the listener
    async execute(input: any) {
      return [{ type: 'text', text: `todos written: ${JSON.stringify(input)}` }]
    },
  }))
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('ccg-root'), { provider: 'mock', model: 'mock' })
  return { ctx, agent, compact, home }
}

/** Todos array for the scripted todo_write arguments. */
function todos(items: Array<[string, string]>): unknown[] {
  return items.map(([content, status]) => ({ content, status, activeForm: content }))
}

function ledgerRows(home: string): Record<string, unknown>[] {
  try {
    return readFileSync(join(home, 'compaction-cost-gate', `${projectKeyOf(process.cwd())}.jsonl`), 'utf8')
      .split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>)
  } catch {
    return []
  }
}

async function waitFor(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('compaction-cost-gate composition (real loop)', () => {
  it('todo completion mid-turn arms; idle fires compactNow once with the hint set and a fresh signal; a second completion is blocked by cooldown', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ccg-comp-'))
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'todo_write', { todos: todos([['step-one', 'completed'], ['step-two', 'pending']]) }),
      textResponse('ok'),
      toolCallResponse('c2', 'todo_write', { todos: todos([['step-two', 'completed'], ['step-three', 'pending']]) }),
      textResponse('done'),
    ])
    const { agent, compact } = await build(home, adapter)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'work the plan' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // The idle seam fired exactly one gated compaction on the root agent.
    await waitFor(() => compact.calls.length === 1)
    expect(compact.calls[0]!.source).toBe('compaction-cost-gate')
    expect(compact.calls[0]!.agent.session).toBe(agent.session)
    expect(compact.calls[0]!.signal.aborted).toBe(false)
    expect(compact.hintsAtCall[0]).toContain('plan-step-complete:step-one')
    expect(takeCompactHint(agent)).toBeUndefined()

    // The second todo completion lands inside the cooldown: no second call.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await new Promise((r) => setTimeout(r, 50))
    expect(compact.calls).toHaveLength(1)
    rmSync(home, { recursive: true, force: true })
  })

  it('mode dry-run never calls compactNow but ledgers both sides of the inequality', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ccg-dry-'))
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'todo_write', { todos: todos([['step-one', 'completed'], ['step-two', 'pending']]) }),
      textResponse('ok'),
    ])
    const { agent, compact } = await build(home, adapter, { mode: 'dry-run' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'work the plan' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await new Promise((r) => setTimeout(r, 50))
    expect(compact.calls).toHaveLength(0)
    expect(ledgerRows(home).some((r) => r.kind === 'gate')).toBe(true)
    rmSync(home, { recursive: true, force: true })
  })

  it('PASS-TRIPWIRE: an observe-only post-execute listener returns the downstream decision unchanged', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ccg-pass-'))
    let downstream: unknown
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'todo_write', { todos: todos([['step-one', 'in_progress']]) }),
      textResponse('ok'),
    ])
    const { agent } = await build(home, adapter, { afterPlugin: (ctx) => {
      ctx.on('tools/post-execute', async (_exec, _result, next) => {
        downstream = await next()
        return downstream
      })
    } })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'work the plan' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(downstream).toMatchObject({ kind: 'accept' })
    rmSync(home, { recursive: true, force: true })
  })

  it('hint is cleared on a throwing compaction backend (failure path)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ccg-fail-'))
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'todo_write', { todos: todos([['step-one', 'completed'], ['step-two', 'pending']]) }),
      textResponse('ok'),
    ])
    const { agent, compact } = await build(home, adapter)
    compact.failure = new ManualCompactionError('changed', 'backend broke')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'work the plan' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await waitFor(() => compact.calls.length === 1)
    // The failure is ledgered as a real defect class. Poll the ledger row —
    // the failure-path side effects (ledger append + hint clear) resolve
    // after the call itself, so a fixed sleep races under CI load.
    await waitFor(() => ledgerRows(home).some((r) => r.kind === 'failed:changed'))
    await waitFor(() => takeCompactHint(agent) === undefined)
    rmSync(home, { recursive: true, force: true })
  })
})
