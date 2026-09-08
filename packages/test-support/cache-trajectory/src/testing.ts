/**
 * Testkit-style composition mounting for trajectory runs. Keyless runs point
 * the real DeepSeek adapter at a local mock server (`baseURL`); cc-flavored
 * runs additionally mount the dsh-cc agent-plane plugins that are mountable
 * without the deployed host plane (token meter + microcompactor, passive).
 * The caller owns the context and its disposal.
 * @module @dsh-cc/cache-trajectory/testing
 */

import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import {
  startMockLlmServer,
  type MockLlmBehavior,
  type MockLlmServer,
} from '@deepseek-ai/dsh-llm-mock-server'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Microcompactor from '@dsh-cc/compaction-micro'

/** Options for {@link mountTrajectoryTestStack}. */
export interface TrajectoryStackOptions {
  /** Deployment persona for the tree (system-prompt plugin config). */
  readonly persona: string
  /** Point the DeepSeek adapter at an OpenAI-compatible mock server. */
  readonly baseURL?: string
  /** Mount the dsh-cc agent-plane plugins (token meter + passive microcompactor). */
  readonly ccPlugins?: boolean
}

/**
 * Mount the minimal agent-loop composition used by every trajectory e2e and
 * by the benchmark bin: prerequisite services, the DeepSeek adapter (optionally
 * mock-backed), the agent loop, and optionally the dsh-cc plugins.
 */
export async function mountTrajectoryTestStack(
  ctx: Context,
  options: TrajectoryStackOptions,
): Promise<void> {
  // Harness 0.1.2-rc.1: the system-prompt persona knob is `persona` (a plain
  // template string).
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: options.persona } })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LlmDeepSeek, options.baseURL === undefined ? {} : { baseURL: options.baseURL })
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.ccPlugins === true) {
    await ctx.plugin(TokenMeter)
    // Mounted passive (config default auto:false): the cc agent-plane plugin
    // is present so the trajectory exercises the real plugin surface, while
    // the append-only prefix invariant stays in its guarded scope.
    await ctx.plugin(Microcompactor)
  }
}

/** Options for {@link startKeylessTrajectoryStack}. */
export interface KeylessTrajectoryStackOptions extends TrajectoryStackOptions {
  /**
   * Ordered mock behaviors consumed one per request; the last repeats.
   * Default: tool call, then four plain answers.
   */
  readonly mockSequence?: readonly MockLlmBehavior[]
  /** Tool name the mock's `tool_call_success` behavior emits. */
  readonly toolName?: string
  /** Raw JSON arguments the mock's tool call carries. */
  readonly toolArguments?: string
  /** Deterministic text returned by the mock's success behavior. */
  readonly successText?: string
}

/** A booted keyless stack: context, mock server, and a combined dispose. */
export interface KeylessTrajectoryStack {
  readonly ctx: Context
  readonly server: MockLlmServer
  /** Dispose the context and close the mock server; idempotent per part. */
  close(): Promise<void>
}

/**
 * Boot a complete keyless stack: a local scripted mock server plus a context
 * whose real DeepSeek adapter points at it. Seeds a placeholder
 * DEEPSEEK_API_KEY only when the ambient environment has none (the adapter
 * resolves a credential per call even against the mock).
 */
export async function startKeylessTrajectoryStack(
  options: KeylessTrajectoryStackOptions,
): Promise<KeylessTrajectoryStack> {
  process.env.DEEPSEEK_API_KEY ??= 'mock-key'
  const server = await startMockLlmServer({
    sequence: options.mockSequence ?? ['tool_call_success', 'success', 'success', 'success', 'success'],
    repeatLast: true,
    ...(options.toolName !== undefined ? { toolName: options.toolName } : {}),
    ...(options.toolArguments !== undefined ? { toolArguments: options.toolArguments } : {}),
    ...(options.successText !== undefined ? { successText: options.successText } : {}),
    chunkSize: 16,
    chunkDelayMs: 0,
  })
  const ctx: Context = new Context()
  await mountTrajectoryTestStack(ctx, {
    persona: options.persona,
    baseURL: server.baseURL,
    ...(options.ccPlugins !== undefined ? { ccPlugins: options.ccPlugins } : {}),
  })
  return {
    ctx,
    server,
    close: async (): Promise<void> => {
      await ctx.fiber.dispose()
      await server.close()
    },
  }
}
