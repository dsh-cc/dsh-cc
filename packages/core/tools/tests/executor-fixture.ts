/**
 * Shared executor fixture for the fork's tool specs: mounts the registry plus
 * the fork's `native` / `code` / `both` executor, and adapts a single
 * `ToolExecutionInput` onto one batch `execute({ calls })` so the pre-existing
 * single-call tests keep their shape under the executor-owned pipeline.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '../src/index.ts'
import { ToolExecutionPipeline } from '../src/pipeline.ts'
import { CcToolExecutor } from '../src/cc-executor.ts'
import type { Config, ToolPresentationMode } from '../src/cc-executor.ts'
import type { ToolExecutionInput, ToolExecutionResult } from '../src/index.ts'

/** Options for {@link mountExecutorFixture}. */
export interface ExecutorFixtureOptions {
  /** Presentation mode; `native` (default) runs every call directly. */
  mode?: ToolPresentationMode
  /** `run_code` sub-dispatch concurrency. */
  maxParallelSubCalls?: number
  /** Extra plugins mounted before the executor (in registration order). */
  plugins?: readonly (() => Promise<unknown>)[]
}

/** A mounted registry + fork executor, with single-call and batch adapters. */
export interface ExecutorFixture {
  readonly ctx: Context
  readonly executor: CcToolExecutor
  /** One call through the executor's batch surface, as the agent loop does it. */
  execute(input: ToolExecutionInput): Promise<ToolExecutionResult>
  /** The raw batch call (root events, deferred context, conclusions). */
  executeBatch(input: {
    calls: readonly ToolCallBlock[]
    signal: AbortSignal
    agent?: Agent
    log?: { turn: number, step: number }
    maxParallelToolCalls?: number
  }): ReturnType<CcToolExecutor['execute']>
}

/**
 * Mount `SystemPrompt` + the fork registry + the fork executor into a fresh context.
 * @param options - presentation mode, sub-dispatch concurrency, extra plugins.
 * @returns the mounted fixture.
 */
export async function mountExecutorFixture(options: ExecutorFixtureOptions = {}): Promise<ExecutorFixture> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  for (const plugin of options.plugins ?? []) await ctx.plugin(plugin as never)
  const config: Partial<Config> = {
    mode: options.mode ?? 'native',
    ...options.maxParallelSubCalls === undefined ? {} : { maxParallelSubCalls: options.maxParallelSubCalls },
  }
  const executor = new CcToolExecutor(ctx, config)
  ctx.tools.setExecutor(executor)
  return {
    ctx,
    executor,
    async execute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
      const result = await fixtureExecuteBatch({
        calls: [{
          type: 'tool-call',
          id: input.callId,
          name: input.name,
          arguments: JSON.stringify(input.arguments ?? {}),
        } as ToolCallBlock],
        signal: input.signal,
        ...input.agent === undefined ? {} : { agent: input.agent },
      })
      const outcome = result.results[0]
      if (outcome === undefined) throw new Error('executor omitted the single-call result')
      return outcome.result
    },
    executeBatch: input => fixtureExecuteBatch(input),
  }

  async function fixtureExecuteBatch(input: {
    calls: readonly ToolCallBlock[]
    signal: AbortSignal
    agent?: Agent
    log?: { turn: number, step: number }
    maxParallelToolCalls?: number
  }) {
    return executor.execute(input)
  }
}

/**
 * Run ONE parsed invocation through the FORK's pipeline stages, preserving
 * nested identity (the `parent` token) and step admission. This is the
 * single-call adapter the pre-executor specs used as `ctx.tools.execute(input)`.
 *
 * The upstream testkit's `executeToolFixture` is deliberately NOT used here: it
 * is built on `@deepseek-ai/dsh-tools/pipeline`, which would exercise upstream's
 * policy copy against this fork's registry.
 * @param ctx - context owning the registry and execution policy.
 * @param input - parsed invocation.
 * @returns the settled capability result.
 */
export async function executeToolInvocation(ctx: Context, input: ToolExecutionInput): Promise<ToolExecutionResult> {
  const pipeline = new ToolExecutionPipeline(ctx)
  const prepared = await pipeline.prepare(input)
  const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared
  return pipeline.complete(prepared.exec, outcome)
}

/**
 * Run ONE parsed invocation through the SELECTED executor (`ctx.tools.execute`),
 * i.e. the path the agent loop takes — the adapter for specs that dispatch
 * executor-owned capabilities (the reserved `run_code` transport) rather than
 * registry-registered ones.
 * @param ctx - context whose scope has a selected executor.
 * @param input - parsed invocation.
 * @returns the settled capability result.
 */
export async function executeThroughExecutor(ctx: Context, input: ToolExecutionInput): Promise<ToolExecutionResult> {
  const args = JSON.stringify(input.arguments ?? {})
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- JSON.stringify yields undefined for non-JSON arguments
  if (args === undefined) throw new TypeError('executor fixture arguments must encode as JSON')
  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: args } as ToolCallBlock],
    signal: input.signal,
    ...input.agent === undefined ? {} : { agent: input.agent },
  })
  const outcome = batch.results[0]
  if (outcome === undefined) throw new Error('executor omitted the single-call result')
  return outcome.result
}

/**
 * A `tool-call` block with JSON-encoded arguments, for batch-level specs.
 * @param id - the model call id.
 * @param name - the tool name.
 * @param args - the parsed arguments (JSON-encoded here).
 * @returns the raw call block.
 */
export function toolCall(id: string, name: string, args: unknown = {}): ToolCallBlock {
  return { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) } as ToolCallBlock
}

/** Re-exported so specs do not import the session helpers piecemeal. */
export { createUserMessage }
