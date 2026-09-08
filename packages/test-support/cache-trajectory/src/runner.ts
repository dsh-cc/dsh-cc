/**
 * Deterministic trajectory runner: drives the standard trajectory turn by
 * turn over a booted agent-loop context, folds every request's usage off the
 * durable event log, and folds the cache-trajectory report. Composition
 * agnostic — the caller boots the context (testkit stack, cc plugin stack, or
 * a deployed composition) and owns disposal.
 * @module @dsh-cc/cache-trajectory/runner
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  defineContentToolFixture,
  type ParameterSchemaSpec,
} from '@deepseek-ai/dsh-tools'
import type { CacheTrajectory } from './trajectory.ts'
import {
  foldReport,
  type CacheTrajectoryReport,
  type RequestUsageRow,
  type Thresholds,
} from './report.ts'

/** Default per-turn idle timeout: a hung turn must fail the run, not hang it. */
const DEFAULT_TURN_TIMEOUT_MS = 180_000

/** Options for {@link runCacheTrajectory}. */
export interface RunCacheTrajectoryOptions {
  /** Overrides the trajectory's provider route (e.g. a mock-backed route). */
  readonly provider?: string
  /** Overrides the trajectory's model id (e.g. `mock-model`). */
  readonly model?: string
  /**
   * False for keyless runs (mock LLM usage carries no cache buckets): the
   * cache criteria then leave the verdict entirely. Default true.
   */
  readonly cacheHitsExpected?: boolean
  /** Overrides the trajectory's thresholds (e.g. env-adjusted floors). */
  readonly thresholds?: Thresholds
  /** Idle timeout per turn. Default 180s. */
  readonly timeoutMsPerTurn?: number
}

/** One executed trajectory run. */
export interface TrajectoryRunResult {
  readonly report: CacheTrajectoryReport
  /** The agent that drove the trajectory (caller disposes via the context). */
  readonly agent: Agent
  readonly firstTurnToolCalls: number
}

/** The agent-loop service face the runner needs. */
interface AgentLoopLike {
  create(id: ReturnType<typeof SessionId>, options: {
    provider?: string
    model?: string
  }): Agent
}

/** The tools-registry face the runner needs. */
interface ToolsLike {
  get(name: string): { name: string } | undefined
  register(tool: { name: string }): void
}

function withTimeout(promise: Promise<void>, ms: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(label)) }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** Register the trajectory's deterministic content tools (skip existing names). */
function registerTrajectoryTools(ctx: Context, trajectory: CacheTrajectory): void {
  const tools = (ctx as { tools?: ToolsLike }).tools
  if (tools === undefined) {
    throw new Error('cache-trajectory: the context has no tools registry; boot a composition with the tool runtime first')
  }
  for (const tool of trajectory.tools) {
    if (tools.get(tool.name) !== undefined) continue
    tools.register(defineContentToolFixture({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as ParameterSchemaSpec,
      async execute(args) {
        const values = args as Record<string, unknown>
        const text = tool.resultText.replace(/\{(\w+)\}/g, (_match, key: string) => {
          return String(values[key] ?? '')
        })
        return [{ type: 'text', text }]
      },
    }) as { name: string })
  }
}

/**
 * Run one trajectory to completion and fold its report. Shape invariants are
 * always asserted (request count floor, per-request usage presence, forced
 * tool call); cache invariants only when `cacheHitsExpected`. Throws on a hung
 * turn or a boot-shape problem; invariant failures are reported through the
 * report's `verdict`/`failures`, not exceptions.
 */
export async function runCacheTrajectory(
  ctx: Context,
  trajectory: CacheTrajectory,
  options: RunCacheTrajectoryOptions = {},
): Promise<TrajectoryRunResult> {
  const loop = (ctx as { agentLoop?: AgentLoopLike }).agentLoop
  if (loop === undefined) {
    throw new Error('cache-trajectory: the context has no agentLoop service; boot a composition with the agent loop first')
  }
  registerTrajectoryTools(ctx, trajectory)

  const provider = options.provider ?? trajectory.provider
  const model = options.model ?? trajectory.model
  const agent = loop.create(SessionId(trajectory.sessionId), { provider, model })
  const timeoutMsPerTurn = options.timeoutMsPerTurn ?? DEFAULT_TURN_TIMEOUT_MS
  const startedAt = new Date().toISOString()

  for (const [index, turn] of trajectory.turns.entries()) {
    const idle = agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: turn.text }],
      source: { kind: 'user' },
    }))
    await withTimeout(idle, timeoutMsPerTurn, `cache-trajectory: turn ${index + 1} did not go idle within ${timeoutMsPerTurn}ms`)
  }

  const finishedAt = new Date().toISOString()
  const events: readonly SessionEvent[] = agent.session.snapshotEvents()

  const rows: RequestUsageRow[] = []
  const rowsWithoutUsage: number[] = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const index = rows.length
    const usage = event.data.usage
    rows.push({
      index,
      turn: event.data.turn,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
      ...(usage?.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    })
    if (usage === undefined) rowsWithoutUsage.push(index + 1)
  }

  const firstTurn = rows[0]?.turn
  let firstTurnToolCalls = 0
  if (firstTurn !== undefined) {
    for (const event of events) {
      if (event.type === 'tool/call' && event.data.turn === firstTurn) firstTurnToolCalls += 1
    }
  }

  const firstTurnExpectsToolCall = trajectory.turns[0]?.expectToolCall ?? false
  const report = foldReport({
    trajectoryId: trajectory.id,
    sessionId: trajectory.sessionId,
    provider,
    model,
    rows,
    thresholds: options.thresholds ?? trajectory.thresholds,
    minRequests: trajectory.minRequests,
    cacheHitsExpected: options.cacheHitsExpected ?? true,
    firstTurnToolCalls,
    firstTurnExpectsToolCall,
    rowsWithoutUsage,
    startedAt,
    finishedAt,
  })

  return { report, agent, firstTurnToolCalls }
}
