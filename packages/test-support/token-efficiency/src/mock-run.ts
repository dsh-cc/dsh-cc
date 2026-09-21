/**
 * Mock-script tier runner (plan §3.2): scripted runs through the REAL plugin
 * stack — MockAdapter stands in ONLY for the LLM (composition.spec.ts
 * precedent). A scenario table keyed by task id boots the feature plugin
 * under test, drives the real agent loop on the descriptor prompt, and folds
 * events + feature-owned counters into a MetricVector with `capability.ok`.
 *
 * Mock vectors are wiring-regression evidence only; the bin never writes them
 * into the baseline blob (gate §3.2: token axes reported, never gate mock).
 *
 * @module @dsh-cc/token-efficiency/mock-run
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import CcBasicCompactionEngine from '@dsh-cc/compaction-basic'
import CompactionCostGate, { foldCounters as foldCostGateCounters } from '@dsh-cc/compaction-cost-gate'
import ContextCrusher, { foldCounters as foldCcrCounters } from '@dsh-cc/context-crusher'
import { defineContentToolFixture } from '@dsh-cc/tools'
import type { SessionLogEvent } from '@dsh-cc/cache-trajectory'
import type { TaskDescriptor } from './corpus.ts'
import { foldMetricVector, type MetricVector } from './metrics.ts'

/** Materials a scenario hands back for folding (ccr fold reads events; costgate reads the ledger under dshHome). */
interface RunMaterials {
  readonly events: readonly SessionLogEvent[]
  readonly dshHome: string
  /** The scripted run completed cleanly to its final text. */
  readonly ok: boolean
  /** Dispose the booted context (temp-home removal happens in the wrapper). */
  dispose(): Promise<void>
}

type Scenario = (descriptor: TaskDescriptor, home: string) => Promise<RunMaterials>

const HOME_PREFIX = 'token-efficiency-mock-'

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), HOME_PREFIX))
}

/** The real event channel: the session surface accessor + eventAt, never snapshotEvents. */
function sessionEvents(agent: Agent): SessionLogEvent[] {
  const out: SessionLogEvent[] = []
  for (const seq of [...agent.session.surface.nodes]) {
    const event = agent.session.eventAt(seq) as unknown as SessionLogEvent | undefined
    if (event !== undefined) out.push(event)
  }
  return out
}

/** Run one real agent-loop turn on `prompt` and wait for idle. */
async function runTurn(agent: Agent, prompt: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** dshHomePath seam: a real boot provides it; mock runs point it at a temp home. */
function pointDshHomeAt(ctx: Context, home: string): void {
  ;(ctx as unknown as { dshHomePath: (...segments: string[]) => string }).dshHomePath =
    (...segments: string[]) => join(home, ...segments)
}

/**
 * Settle seam: idle listeners (gate evaluation → compactNow) run
 * fire-and-forget, so wait until the ledger counters stop changing across a
 * 100ms window before folding.
 */
async function settledCounters(home: string, timeoutMs = 3000): Promise<Record<string, number>> {
  const deadline = Date.now() + timeoutMs
  let last = costGateCounters(home)
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const next = costGateCounters(home)
    if (JSON.stringify(next) === JSON.stringify(last)) return next
    last = next
  }
  return last
}

/**
 * A grep-shaped output large enough to clear the crusher size gate
 * (context-crusher composition.spec.ts precedent).
 */
function bigGrepOutput(): string {
  const lines: string[] = []
  for (let i = 0; i < 120; i++) {
    const file = `src/components/deeply/nested/really/long/module-path-${i % 4}.ts`
    lines.push(`${file}:${100 + i}:  someMatchyFunctionCall(argument-${i}, { option: ${i}, extra: 'padding to make the row long enough for a solid saving ratio' })`)
  }
  return lines.join('\n')
}

/** Boot the real context-crusher stack (only the model is mocked). */
async function bootCcr(
  home: string,
  adapter: MockAdapter,
  toolOutput: string,
  sessionId: string,
): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  void new TokenMeter(ctx)
  pointDshHomeAt(ctx, home)
  await ctx.plugin(ContextCrusher, {
    enabled: true,
    mode: 'on',
    'min-bytes': 300,
    'min-savings-ratio': 0.25,
  })
  // Structural cast: the fixture is a @dsh-cc/tools ToolDefinition; the ctx
  // merge type comes from the harness link dep (same shape, twin identity).
  ctx.tools.register(defineContentToolFixture({
    name: 'biggrep', description: 'big fixture tool', parameters: {},
    async execute() { return [{ type: 'text', text: toolOutput }] },
  }) as never)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(sessionId), { provider: 'mock', model: 'mock' })
  return { ctx, agent }
}

/** Scenario: crusher ENABLED; large fixture-tool output crosses the gate → marker committed. */
async function ccrFires(descriptor: TaskDescriptor, home: string): Promise<RunMaterials> {
  const adapter = new MockAdapter([toolCallResponse('c1', 'biggrep', {}), textResponse('done')])
  const { ctx, agent } = await bootCcr(home, adapter, bigGrepOutput(), 'mock-ccr-fires')
  try {
    await runTurn(agent, descriptor.prompt ?? 'search the code')
    return {
      events: sessionEvents(agent),
      dshHome: home,
      ok: adapter.requests.length === 2,
      dispose: () => ctx.fiber.dispose(),
    }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

/** Sharper control: plugin ENABLED, output small (below min-bytes) → no compression. */
async function ccrControl(descriptor: TaskDescriptor, home: string): Promise<RunMaterials> {
  const adapter = new MockAdapter([toolCallResponse('c1', 'biggrep', {}), textResponse('done')])
  const { ctx, agent } = await bootCcr(home, adapter, 'a short row:1:tiny', 'mock-ccr-control')
  try {
    await runTurn(agent, descriptor.prompt ?? 'search the code')
    return {
      events: sessionEvents(agent),
      dshHome: home,
      ok: adapter.requests.length === 2,
      dispose: () => ctx.fiber.dispose(),
    }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

/** Todos array for the scripted todo_write arguments (cost-gate composition precedent). */
function todos(items: Array<[string, string]>): unknown[] {
  return items.map(([content, status]) => ({ content, status, activeForm: content }))
}

/**
 * Boot the real compaction-cost-gate stack: real agent loop, real token meter,
 * REAL basic compaction engine (auto off; the gate drives compactNow), gate
 * plugin with scenario-controlled settings. Only the model is mocked.
 */
async function bootCostGate(
  home: string,
  adapter: MockAdapter,
  margin: number,
  sessionId: string,
): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  void new TokenMeter(ctx)
  pointDshHomeAt(ctx, home)
  const engine = new CcBasicCompactionEngine(ctx, { auto: false })
  // The gate's idle listener is fire-and-forget: it can enter compactNow
  // before the just-finished turn's teardown fully settles, and the real
  // engine's summary stage then fails the stability window ("could not
  // produce a smaller summary"). A real host schedules idle maintenance after
  // teardown; one microtask defer reproduces that ordering. Without it the
  // fires-case fails deterministically under the plain runner (vitest AND
  // tsx); with it, 10/10 stable.
  // ponytail: defer shim, remove when dsh-compaction sequences idle
  // maintenance strictly after turn teardown.
  const orig = engine.compactNow.bind(engine)
  ;(engine as unknown as { compactNow: unknown }).compactNow = async (...a: unknown[]) => {
    await Promise.resolve()
    return (orig as (...x: unknown[]) => unknown)(...a) as never
  }
  await ctx.plugin(CompactionCostGate, {
    readSettings: () => ({ enabled: true, mode: 'on', margin, cooldownMs: 600_000 }),
  })
  // Structural cast: the fixture is a @dsh-cc/tools ToolDefinition; the ctx
  // merge type comes from the harness link dep (same shape, twin identity).
  ctx.tools.register(defineContentToolFixture({
    name: 'todo_write', description: 'write the plan todos', parameters: {},
    async execute(input: unknown) {
      return [{ type: 'text', text: `todos written: ${JSON.stringify(input)}` }]
    },
  }) as never)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(sessionId), { provider: 'mock', model: 'mock' })
  return { ctx, agent }
}

/** Fold the gate's own ledger for this run's temp home. */
function costGateCounters(home: string): Record<string, number> {
  return foldCostGateCounters({ events: [], dshHome: home })
}

/**
 * Scenario: todo completion arms the boundary; idle evaluates the gate with a
 * tiny margin (inequality passes) → REAL compactNow runs end-to-end through
 * the real basic engine; the MockAdapter answers the compaction-purpose call.
 */
async function costGateFires(descriptor: TaskDescriptor, home: string): Promise<RunMaterials> {
  const adapter = new MockAdapter([
    toolCallResponse('c1', 'todo_write', { todos: todos([['step-one', 'completed'], ['step-two', 'pending']]) }),
    textResponse('plan noted'),
    // The basic engine rejects a summary that is not SMALLER than the compacted
    // span ("could not produce a smaller summary") — the mock answers terse.
    textResponse('s'),
  ])
  const { ctx, agent } = await bootCostGate(home, adapter, 0.01, 'mock-costgate-fires')
  try {
    await runTurn(agent, descriptor.prompt ?? 'work the plan')
    // The idle listener runs fire-and-forget: settle until the gate row lands.
    const settled = await settledCounters(home)
    const ok = (settled['costgate.gate'] ?? 0) >= 1
    return {
      events: sessionEvents(agent),
      dshHome: home,
      ok,
      dispose: () => ctx.fiber.dispose(),
    }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

/** Control: gate armed and evaluated, but the inequality fails (huge margin) → never compacts. */
async function costGateControl(descriptor: TaskDescriptor, home: string): Promise<RunMaterials> {
  const adapter = new MockAdapter([
    toolCallResponse('c1', 'todo_write', { todos: todos([['step-one', 'completed'], ['step-two', 'pending']]) }),
    textResponse('plan noted'),
  ])
  const { ctx, agent } = await bootCostGate(home, adapter, 10, 'mock-costgate-control')
  try {
    await runTurn(agent, descriptor.prompt ?? 'work the plan')
    const settled = await settledCounters(home)
    const ok = (settled['costgate.gate'] ?? 0) >= 1
    return {
      events: sessionEvents(agent),
      dshHome: home,
      ok,
      dispose: () => ctx.fiber.dispose(),
    }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

const SCENARIOS: Record<string, Scenario> = {
  'mock/ccr-fires': ccrFires,
  'mock/ccr-control': ccrControl,
  'mock/costgate-fires': costGateFires,
  'mock/costgate-control': costGateControl,
}

/**
 * Run one mock-script task through its real-stack scenario and fold the
 * shared metric vector: foldMetricVector over the session events, counters
 * merged from the feature-owned foldCounters, plus `capability.ok`.
 * Unknown mock id → loud error (never a silent drop).
 */
export async function runMockTask(descriptor: TaskDescriptor): Promise<MetricVector> {
  const scenario = SCENARIOS[descriptor.id]
  if (scenario === undefined) {
    throw new Error(`no mock scenario registered for task ${descriptor.id} (mock-run scenario table)`)
  }
  const home = makeHome()
  try {
    const materials = await scenario(descriptor, home)
    const vector = foldMetricVector(materials.events, { task: descriptor.id })
    Object.assign(vector.counters, foldCcrCounters({ events: materials.events, dshHome: materials.dshHome }))
    Object.assign(vector.counters, foldCostGateCounters({ events: materials.events, dshHome: materials.dshHome }))
    vector.capability = { ok: materials.ok }
    await materials.dispose()
    return vector
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10 })
  }
}

/** Whether a mock descriptor has a registered scenario (bin reporting). */
export function hasMockScenario(descriptor: TaskDescriptor): boolean {
  return descriptor.kind === 'mock-script' && SCENARIOS[descriptor.id] !== undefined
}
